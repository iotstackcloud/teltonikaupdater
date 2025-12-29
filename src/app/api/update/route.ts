import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { routerDb, updateHistoryDb, batchJobDb, settingsDb } from '@/lib/db';
import { performUpdate, verifyUpdateAfterReboot, getFirmwareInfo } from '@/lib/ssh-service';

// Store for active batch processes
const activeBatches = new Map<string, { abort: boolean }>();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { routerIds, batchSize = 5 } = body as { routerIds?: string[]; batchSize?: number };

    const globalCreds = settingsDb.getGlobalCredentials();

    // Get routers to update
    let routers;
    if (routerIds && routerIds.length > 0) {
      routers = routerIds.map(id => routerDb.getById(id)).filter(Boolean);
    } else {
      // Get all routers with available updates
      routers = routerDb.getByStatus('update_available');
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
    processBatchUpdate(jobId, routers, batchSize, globalCreds);

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

    return NextResponse.json({ success: true, message: 'Batch job cancelled' });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to cancel job'
    }, { status: 500 });
  }
}

async function processBatchUpdate(
  jobId: string,
  routers: any[],
  batchSize: number,
  globalCreds: { username: string; password: string } | null
) {
  const WAIT_AFTER_UPDATE_MS = 10 * 60 * 1000; // 10 minutes

  batchJobDb.update(jobId, {
    status: 'running',
    started_at: new Date().toISOString()
  });

  let completedCount = 0;
  let failedCount = 0;

  // Process in batches
  for (let i = 0; i < routers.length; i += batchSize) {
    const batch = activeBatches.get(jobId);
    if (batch?.abort) {
      console.log(`Batch job ${jobId} aborted`);
      break;
    }

    const currentBatch = routers.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}, routers: ${currentBatch.length}`);

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

      if (!username || !password) {
        updateHistoryDb.update(historyId, {
          status: 'failed',
          error_message: 'No credentials available',
          completed_at: new Date().toISOString()
        });
        routerDb.updateStatus(router.id, 'error');
        return { success: false };
      }

      try {
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
          return { success: false };
        }

        // Wait for router to come back online and verify update
        console.log(`Waiting for router ${router.device_name} to reboot...`);

        const verification = await verifyUpdateAfterReboot(
          { host: router.ip_address, username, password },
          router.available_firmware,
          20, // max retries
          30000 // 30 seconds between retries
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
          return { success: true };
        } else {
          updateHistoryDb.update(historyId, {
            status: 'failed',
            error_message: verification.error || 'Verification failed',
            completed_at: new Date().toISOString()
          });
          routerDb.updateStatus(router.id, 'error');
          return { success: false };
        }
      } catch (error) {
        updateHistoryDb.update(historyId, {
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
          completed_at: new Date().toISOString()
        });
        routerDb.updateStatus(router.id, 'error');
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

    // Wait 10 minutes before processing next batch (unless this is the last batch)
    if (i + batchSize < routers.length && !activeBatches.get(jobId)?.abort) {
      console.log(`Waiting ${WAIT_AFTER_UPDATE_MS / 60000} minutes before next batch...`);
      await new Promise(resolve => setTimeout(resolve, WAIT_AFTER_UPDATE_MS));
    }
  }

  // Mark job as completed
  const finalStatus = activeBatches.get(jobId)?.abort ? 'cancelled' : 'completed';
  batchJobDb.update(jobId, {
    status: finalStatus,
    completed_at: new Date().toISOString()
  });

  activeBatches.delete(jobId);
  console.log(`Batch job ${jobId} ${finalStatus}. Completed: ${completedCount}, Failed: ${failedCount}`);
}
