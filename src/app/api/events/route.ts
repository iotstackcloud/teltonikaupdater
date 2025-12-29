import { NextRequest } from 'next/server';
import { updateEvents, UpdateEvent } from '@/lib/event-emitter';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const jobId = searchParams.get('jobId');

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (event: UpdateEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      // Send initial connection event
      sendEvent({
        type: 'job_started',
        jobId: jobId || 'all',
        timestamp: new Date().toISOString(),
        data: { message: 'Connected to event stream' }
      });

      // Subscribe to events
      let unsubscribe: () => void;

      if (jobId) {
        unsubscribe = updateEvents.subscribe(jobId, sendEvent);
      } else {
        unsubscribe = updateEvents.subscribeAll(sendEvent);
      }

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
