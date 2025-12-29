import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { routerDb, updateHistoryDb, batchJobDb, settingsDb, Router } from '@/lib/db';
import { performUpdate, verifyUpdateAfterReboot } from '@/lib/ssh-service';
import { updateEvents } from '@/lib/event-emitter';

// Store for active batch processes
const activeBatches = new Map<string, { abort: boolean }>();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { routerIds, batchSize = 5, includeErrors = false } = body as {
      routerIds?: string[];
      batchSize?: number;
      includeErrors?: boolean;
    };

    const globalCreds = settingsDb.getGlobalCredentials();
    const waitTimeMinutes = settingsDb.getBatchWaitTime();

    // Get routers to update
    let routers: Router[];
    if (routerIds && routerIds.length > 0) {
      routers = routerIds.map(id => routerDb.getById(id)).filter((r): r is Router => r !== undefined);
    } else {
      // Get all routers with available updates
      routers = routerDb.getByStatus('update_available');

      // Also include error/unreachable routers if requested (for retry)
      if (includeErrors) {
        const errorRouters = routerDb.getByStatus('error');
        const unreachableRouters = routerDb.getByStatus('unreachable');
        routers = [...routers, ...errorRouters, ...unreachableRouters];
      }
    }

    if (routers.length === 0) {
      return NextResponse.json({
        error: 'No routers to update'
      }, { status: 400 });
    }

    // Check if there's already an active batch job
    const activeJob = batchJobDb.getActive();
    if (activeJob) {
      return NextResponse.json({
        error: 'A batch update is already running',
        jobId: activeJob.id
      }, { status: 409 });
    }

    // Create batch job
    const jobId = uuidv4();
    batchJobDb.insert({
      id: jobId,
      status: 'pending',
      batch_size: batchSize,
      total_routers: routers.length,
      created_at: new Date().toISOString()
    });

    // Start batch process in background
    activeBatches.set(jobId, { abort: false });
    processBatchUpdate(jobId, routers, batchSize, globalCreds, waitTimeMinutes);

    return NextResponse.json({
      success: true,
      jobId,
      totalRouters: routers.length,
      batchSize
    });
  } catch (error) {
    console.error('Update error:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Update failed'
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const jobId = searchParams.get('jobId');

    if (jobId) {
      const job = batchJobDb.getById(jobId);
      if (!job) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }
      return NextResponse.json({ job });
    }

    // Return all jobs
    const jobs = batchJobDb.getAll();
    const activeJob = batchJobDb.getActive();

    return NextResponse.json({ jobs, activeJob });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to get jobs'
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'Job ID required' }, { status: 400 });
    }

    // Set abort flag
    const batch = activeBatches.get(jobId);
    if (batch) {
      batch.abort = true;
    }

    batchJobDb.update(jobId, { status: 'cancelled' });

    updateEvents.emit({
      type: 'job_completed',
      jobId,
      timestamp: new Date().toISOString(),
      data: { message: 'Job cancelled by user', status: 'cancelled' }
    });

    return NextResponse.json({ success: true, message: 'Batch job cancelled' });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to cancel job'
    }, { status: 500 });
  }
}

async function processBatchUpdate(
  jobId: string,
  routers: Router[],
  batchSize: number,
  globalCreds: { username: string; password: string } | null,
  waitTimeMinutes: number
) {
  const WAIT_AFTER_UPDATE_MS = waitTimeMinutes * 60 * 1000;
  const totalBatches = Math.ceil(routers.length / batchSize);

  batchJobDb.update(jobId, {
    status: 'running',
    started_at: new Date().toISOString()
  });

  // Emit job started event
  updateEvents.emit({
    type: 'job_started',
    jobId,
    timestamp: new Date().toISOString(),
    data: {
      message: `Starting update job for ${routers.length} routers`,
      total: routers.length,
      totalBatches
    }
  });

  let completedCount = 0;
  let failedCount = 0;

  // Process in batches
  for (let i = 0; i < routers.length; i += batchSize) {
    const batch = activeBatches.get(jobId);
    if (batch?.abort) {
      updateEvents.emit({
        type: 'job_completed',
        jobId,
        timestamp: new Date().toISOString(),
        data: { message: 'Job aborted', status: 'cancelled', completed: completedCount, failed: failedCount }
      });
      break;
    }

    const currentBatch = routers.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;

    // Emit batch started event
    updateEvents.emit({
      type: 'batch_started',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        message: `Starting batch ${batchNumber} of ${totalBatches}`,
        batchNumber,
        totalBatches,
        total: currentBatch.length
      }
    });

    // Process routers in this batch concurrently
    const batchPromises = currentBatch.map(async (router) => {
      const username = router.username || globalCreds?.username;
      const password = router.password || globalCreds?.password;

      const historyId = uuidv4();
      const historyEntry = {
        id: historyId,
        router_id: router.id,
        firmware_before: router.current_firmware,
        firmware_after: null as string | null,
        status: 'running',
        error_message: null as string | null,
        started_at: new Date().toISOString(),
        completed_at: null as string | null
      };

      updateHistoryDb.insert(historyEntry);
      routerDb.updateStatus(router.id, 'updating');

      // Emit router started event
      updateEvents.emit({
        type: 'router_started',
        jobId,
        timestamp: new Date().toISOString(),
        data: {
          routerId: router.id,
          deviceName: router.device_name,
          ipAddress: router.ip_address,
          message: `Starting update for ${router.device_name}`,
          firmwareBefore: router.current_firmware
        }
      });

      if (!username || !password) {
        const error = 'No credentials available';
        updateHistoryDb.update(historyId, {
          status: 'failed',
          error_message: error,
          completed_at: new Date().toISOString()
        });
        routerDb.updateStatus(router.id, 'error');

        updateEvents.emit({
          type: 'router_failed',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            routerId: router.id,
            deviceName: router.device_name,
            ipAddress: router.ip_address,
            message: `Update failed for ${router.device_name}`,
            error
          }
        });

        return { success: false };
      }

      try {
        // Emit progress: downloading
        updateEvents.emit({
          type: 'router_progress',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            routerId: router.id,
            deviceName: router.device_name,
            ipAddress: router.ip_address,
            message: `Downloading firmware for ${router.device_name}`,
            status: 'downloading'
          }
        });

        const result = await performUpdate({
          host: router.ip_address,
          username,
          password
        });

        if (!result.success) {
          updateHistoryDb.update(historyId, {
            status: 'failed',
            error_message: result.error || 'Update failed',
            completed_at: new Date().toISOString()
          });
          routerDb.updateStatus(router.id, 'error');

          updateEvents.emit({
            type: 'router_failed',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              routerId: router.id,
              deviceName: router.device_name,
              ipAddress: router.ip_address,
              message: `Update failed for ${router.device_name}`,
              error: result.error
            }
          });

          return { success: false };
        }

        // Emit progress: rebooting
        updateEvents.emit({
          type: 'router_progress',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            routerId: router.id,
            deviceName: router.device_name,
            ipAddress: router.ip_address,
            message: `Waiting for ${router.device_name} to reboot...`,
            status: 'rebooting'
          }
        });

        const verification = await verifyUpdateAfterReboot(
          { host: router.ip_address, username, password },
          router.available_firmware,
          20,
          30000
        );

        if (verification.success) {
          updateHistoryDb.update(historyId, {
            status: 'success',
            firmware_after: verification.newVersion,
            completed_at: new Date().toISOString()
          });
          routerDb.updateFirmwareInfo(
            router.id,
            verification.newVersion,
            null,
            'up_to_date'
          );

          updateEvents.emit({
            type: 'router_completed',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              routerId: router.id,
              deviceName: router.device_name,
              ipAddress: router.ip_address,
              message: `Update completed for ${router.device_name}`,
              firmwareBefore: router.current_firmware,
              firmwareAfter: verification.newVersion
            }
          });

          return { success: true };
        } else {
          updateHistoryDb.update(historyId, {
            status: 'failed',
            error_message: verification.error || 'Verification failed',
            completed_at: new Date().toISOString()
          });
          routerDb.updateStatus(router.id, 'error');

          updateEvents.emit({
            type: 'router_failed',
            jobId,
            timestamp: new Date().toISOString(),
            data: {
              routerId: router.id,
              deviceName: router.device_name,
              ipAddress: router.ip_address,
              message: `Update verification failed for ${router.device_name}`,
              error: verification.error
            }
          });

          return { success: false };
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        updateHistoryDb.update(historyId, {
          status: 'failed',
          error_message: errorMsg,
          completed_at: new Date().toISOString()
        });
        routerDb.updateStatus(router.id, 'error');

        updateEvents.emit({
          type: 'router_failed',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            routerId: router.id,
            deviceName: router.device_name,
            ipAddress: router.ip_address,
            message: `Update error for ${router.device_name}`,
            error: errorMsg
          }
        });

        return { success: false };
      }
    });

    // Wait for all routers in this batch to complete
    const results = await Promise.all(batchPromises);
    const batchCompleted = results.filter(r => r.success).length;
    const batchFailed = results.filter(r => !r.success).length;

    completedCount += batchCompleted;
    failedCount += batchFailed;

    batchJobDb.update(jobId, {
      completed_routers: completedCount,
      failed_routers: failedCount
    });

    // Emit batch completed event
    updateEvents.emit({
      type: 'batch_completed',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        message: `Batch ${batchNumber} completed`,
        batchNumber,
        totalBatches,
        completed: batchCompleted,
        failed: batchFailed
      }
    });

    // Emit job progress
    updateEvents.emit({
      type: 'job_progress',
      jobId,
      timestamp: new Date().toISOString(),
      data: {
        message: `Progress: ${completedCount + failedCount} of ${routers.length} routers processed`,
        total: routers.length,
        completed: completedCount,
        failed: failedCount,
        progress: Math.round(((completedCount + failedCount) / routers.length) * 100)
      }
    });

    // Wait 10 minutes before processing next batch (unless this is the last batch)
    if (i + batchSize < routers.length && !activeBatches.get(jobId)?.abort) {
      const waitMinutes = WAIT_AFTER_UPDATE_MS / 60000;

      // Emit waiting event with countdown
      for (let remaining = waitMinutes; remaining > 0; remaining--) {
        if (activeBatches.get(jobId)?.abort) break;

        updateEvents.emit({
          type: 'batch_waiting',
          jobId,
          timestamp: new Date().toISOString(),
          data: {
            message: `Waiting ${remaining} minutes before next batch...`,
            waitTimeRemaining: remaining,
            batchNumber: batchNumber + 1,
            totalBatches
          }
        });

        await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 1 minute
      }
    }
  }

  // Mark job as completed
  const finalStatus = activeBatches.get(jobId)?.abort ? 'cancelled' : 'completed';
  batchJobDb.update(jobId, {
    status: finalStatus,
    completed_at: new Date().toISOString()
  });

  // Emit job completed event
  updateEvents.emit({
    type: 'job_completed',
    jobId,
    timestamp: new Date().toISOString(),
    data: {
      message: `Job ${finalStatus}`,
      status: finalStatus,
      total: routers.length,
      completed: completedCount,
      failed: failedCount
    }
  });

  activeBatches.delete(jobId);
  updateEvents.cleanup(jobId);
}
