import { NextRequest, NextResponse } from 'next/server';
import { routerDb, settingsDb, Router } from '@/lib/db';
import { getFirmwareInfo, checkRouterConnectivity } from '@/lib/ssh-service';

const CONCURRENT_CHECKS = 10; // Check 10 routers in parallel

export async function POST(request: NextRequest) {
  console.log('[Check API] Received check request');
  try {
    const body = await request.json();
    const { routerIds } = body as { routerIds?: string[] };
    console.log('[Check API] Checking routers:', routerIds?.length || 'all');

    const globalCreds = settingsDb.getGlobalCredentials();
    let routers: Router[];

    if (routerIds && routerIds.length > 0) {
      routers = routerIds.map(id => routerDb.getById(id)).filter((r): r is Router => r !== undefined);
    } else {
      routers = routerDb.getAll();
    }

    console.log(`[Check API] Starting check for ${routers.length} routers (${CONCURRENT_CHECKS} parallel)`);

    const results: Array<{
      id: string;
      device_name: string;
      status: string;
      current_firmware?: string | null;
      available_firmware?: string | null;
      error?: string;
    }> = [];

    // Process routers in batches for parallel execution
    for (let i = 0; i < routers.length; i += CONCURRENT_CHECKS) {
      const batch = routers.slice(i, i + CONCURRENT_CHECKS);
      console.log(`[Check API] Processing batch ${Math.floor(i / CONCURRENT_CHECKS) + 1}/${Math.ceil(routers.length / CONCURRENT_CHECKS)}`);

      const batchResults = await Promise.all(
        batch.map(async (router) => {
          const username = router.username || globalCreds?.username;
          const password = router.password || globalCreds?.password;

          if (!username || !password) {
            routerDb.updateFirmwareInfo(router.id, null, null, 'error');
            return {
              id: router.id,
              device_name: router.device_name,
              status: 'error',
              error: 'No credentials available'
            };
          }

          try {
            // First check connectivity
            const isConnected = await checkRouterConnectivity({
              host: router.ip_address,
              username,
              password
            });

            if (!isConnected) {
              routerDb.updateFirmwareInfo(router.id, null, null, 'unreachable');
              return {
                id: router.id,
                device_name: router.device_name,
                status: 'unreachable',
                error: 'Router not reachable via SSH'
              };
            }

            // Get firmware info
            const firmwareInfo = await getFirmwareInfo({
              host: router.ip_address,
              username,
              password
            });

            const status = firmwareInfo.updateAvailable ? 'update_available' : 'up_to_date';
            routerDb.updateFirmwareInfo(
              router.id,
              firmwareInfo.current,
              firmwareInfo.available,
              status
            );

            console.log(`[Check API] ${router.device_name}: ${status} (${firmwareInfo.current})`);

            return {
              id: router.id,
              device_name: router.device_name,
              status,
              current_firmware: firmwareInfo.current,
              available_firmware: firmwareInfo.available
            };
          } catch (error) {
            routerDb.updateFirmwareInfo(router.id, null, null, 'error');
            return {
              id: router.id,
              device_name: router.device_name,
              status: 'error',
              error: error instanceof Error ? error.message : 'Unknown error'
            };
          }
        })
      );

      results.push(...batchResults);
    }

    console.log(`[Check API] Completed checking ${results.length} routers`);

    return NextResponse.json({
      success: true,
      checked: results.length,
      results
    });
  } catch (error) {
    console.error('Check error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Check failed'
    }, { status: 500 });
  }
}
