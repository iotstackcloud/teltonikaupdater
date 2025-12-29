import { NextRequest, NextResponse } from 'next/server';
import { routerDb, settingsDb, Router } from '@/lib/db';
import { getFirmwareInfo, checkRouterConnectivity } from '@/lib/ssh-service';
import { updateEvents } from '@/lib/event-emitter';

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

    const totalBatches = Math.ceil(routers.length / CONCURRENT_CHECKS);

    // Emit check started event
    updateEvents.emit({
      type: 'job_started',
      jobId: 'check',
      timestamp: new Date().toISOString(),
      data: {
        message: `Firmware-Prüfung gestartet: ${routers.length} Router`,
        total: routers.length,
        totalBatches
      }
    });

    const results: Array<{
      id: string;
      device_name: string;
      status: string;
      current_firmware?: string | null;
      available_firmware?: string | null;
      error?: string;
    }> = [];

    let checkedCount = 0;

    // Process routers in batches for parallel execution
    for (let i = 0; i < routers.length; i += CONCURRENT_CHECKS) {
      const batch = routers.slice(i, i + CONCURRENT_CHECKS);
      const batchNumber = Math.floor(i / CONCURRENT_CHECKS) + 1;
      console.log(`[Check API] Processing batch ${batchNumber}/${totalBatches}`);

      updateEvents.emit({
        type: 'batch_started',
        jobId: 'check',
        timestamp: new Date().toISOString(),
        data: {
          message: `Prüfe Batch ${batchNumber}/${totalBatches}`,
          batchNumber,
          totalBatches
        }
      });

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

              updateEvents.emit({
                type: 'router_failed',
                jobId: 'check',
                timestamp: new Date().toISOString(),
                data: {
                  routerId: router.id,
                  deviceName: router.device_name,
                  ipAddress: router.ip_address,
                  message: `[${router.device_name}] Nicht erreichbar`,
                  error: 'Router not reachable via SSH'
                }
              });

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

            updateEvents.emit({
              type: status === 'update_available' ? 'router_progress' : 'router_completed',
              jobId: 'check',
              timestamp: new Date().toISOString(),
              data: {
                routerId: router.id,
                deviceName: router.device_name,
                ipAddress: router.ip_address,
                message: status === 'update_available'
                  ? `[${router.device_name}] Update verfügbar: ${firmwareInfo.current} → ${firmwareInfo.available}`
                  : `[${router.device_name}] Aktuell: ${firmwareInfo.current}`,
                status
              }
            });

            return {
              id: router.id,
              device_name: router.device_name,
              status,
              current_firmware: firmwareInfo.current,
              available_firmware: firmwareInfo.available
            };
          } catch (error) {
            routerDb.updateFirmwareInfo(router.id, null, null, 'error');

            updateEvents.emit({
              type: 'router_failed',
              jobId: 'check',
              timestamp: new Date().toISOString(),
              data: {
                routerId: router.id,
                deviceName: router.device_name,
                ipAddress: router.ip_address,
                message: `[${router.device_name}] Fehler: ${error instanceof Error ? error.message : 'Unknown error'}`,
                error: error instanceof Error ? error.message : 'Unknown error'
              }
            });

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
      checkedCount += batchResults.length;

      // Emit progress
      updateEvents.emit({
        type: 'job_progress',
        jobId: 'check',
        timestamp: new Date().toISOString(),
        data: {
          message: `${checkedCount}/${routers.length} Router geprüft`,
          completed: checkedCount,
          total: routers.length,
          progress: Math.round((checkedCount / routers.length) * 100)
        }
      });
    }

    const updateAvailable = results.filter(r => r.status === 'update_available').length;
    const upToDate = results.filter(r => r.status === 'up_to_date').length;
    const failed = results.filter(r => r.status === 'error' || r.status === 'unreachable').length;

    console.log(`[Check API] Completed checking ${results.length} routers`);

    // Emit completed event
    updateEvents.emit({
      type: 'job_completed',
      jobId: 'check',
      timestamp: new Date().toISOString(),
      data: {
        message: `Prüfung abgeschlossen: ${updateAvailable} Updates, ${upToDate} aktuell, ${failed} Fehler`,
        total: results.length,
        completed: upToDate,
        failed
      }
    });

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
