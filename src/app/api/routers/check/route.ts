import { NextRequest, NextResponse } from 'next/server';
import { routerDb, settingsDb } from '@/lib/db';
import { getFirmwareInfo, checkRouterConnectivity } from '@/lib/ssh-service';

export async function POST(request: NextRequest) {
  console.log('[Check API] Received check request');
  try {
    const body = await request.json();
    const { routerIds } = body as { routerIds?: string[] };
    console.log('[Check API] Checking routers:', routerIds?.length || 'all');

    const globalCreds = settingsDb.getGlobalCredentials();
    let routers;

    if (routerIds && routerIds.length > 0) {
      routers = routerIds.map(id => routerDb.getById(id)).filter(Boolean);
    } else {
      routers = routerDb.getAll();
    }

    const results = [];

    for (const router of routers) {
      if (!router) continue;

      const username = router.username || globalCreds?.username;
      const password = router.password || globalCreds?.password;

      if (!username || !password) {
        routerDb.updateFirmwareInfo(router.id, null, null, 'error');
        results.push({
          id: router.id,
          device_name: router.device_name,
          status: 'error',
          error: 'No credentials available'
        });
        continue;
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
          results.push({
            id: router.id,
            device_name: router.device_name,
            status: 'unreachable',
            error: 'Router not reachable via SSH'
          });
          continue;
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

        results.push({
          id: router.id,
          device_name: router.device_name,
          status,
          current_firmware: firmwareInfo.current,
          available_firmware: firmwareInfo.available
        });
      } catch (error) {
        routerDb.updateFirmwareInfo(router.id, null, null, 'error');
        results.push({
          id: router.id,
          device_name: router.device_name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

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
