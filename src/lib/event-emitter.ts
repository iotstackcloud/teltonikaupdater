type EventCallback = (data: UpdateEvent) => void;

export interface UpdateEvent {
  type: 'job_started' | 'job_progress' | 'job_completed' | 'router_started' | 'router_progress' | 'router_completed' | 'router_failed' | 'batch_started' | 'batch_completed' | 'batch_waiting';
  jobId: string;
  timestamp: string;
  data: {
    routerId?: string;
    deviceName?: string;
    ipAddress?: string;
    message?: string;
    progress?: number;
    total?: number;
    completed?: number;
    failed?: number;
    batchNumber?: number;
    totalBatches?: number;
    waitTimeRemaining?: number;
    firmwareBefore?: string;
    firmwareAfter?: string;
    error?: string;
    status?: string;
  };
}

class UpdateEventEmitter {
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private globalListeners: Set<EventCallback> = new Set();

  subscribe(jobId: string, callback: EventCallback): () => void {
    if (!this.listeners.has(jobId)) {
      this.listeners.set(jobId, new Set());
    }
    this.listeners.get(jobId)!.add(callback);
    console.log(`[EventEmitter] Subscribed to job ${jobId}, total listeners: ${this.listeners.get(jobId)!.size}`);

    return () => {
      this.listeners.get(jobId)?.delete(callback);
      console.log(`[EventEmitter] Unsubscribed from job ${jobId}`);
    };
  }

  subscribeAll(callback: EventCallback): () => void {
    this.globalListeners.add(callback);
    console.log(`[EventEmitter] Global subscriber added, total: ${this.globalListeners.size}`);
    return () => {
      this.globalListeners.delete(callback);
      console.log(`[EventEmitter] Global subscriber removed`);
    };
  }

  emit(event: UpdateEvent): void {
    console.log(`[EventEmitter] Emitting ${event.type} for job ${event.jobId}, global listeners: ${this.globalListeners.size}`);

    // Notify job-specific listeners
    this.listeners.get(event.jobId)?.forEach(callback => {
      try {
        callback(event);
      } catch (e) {
        console.error('Event callback error:', e);
      }
    });

    // Notify global listeners
    this.globalListeners.forEach(callback => {
      try {
        callback(event);
      } catch (e) {
        console.error('Global event callback error:', e);
      }
    });
  }

  cleanup(jobId: string): void {
    this.listeners.delete(jobId);
  }

  getStats(): { globalListeners: number; jobListeners: number } {
    let jobListeners = 0;
    this.listeners.forEach(set => jobListeners += set.size);
    return { globalListeners: this.globalListeners.size, jobListeners };
  }
}

// Use globalThis to ensure singleton across module reloads in Next.js dev mode
const globalForEvents = globalThis as unknown as { updateEvents: UpdateEventEmitter | undefined };

export const updateEvents = globalForEvents.updateEvents ?? new UpdateEventEmitter();

if (process.env.NODE_ENV !== 'production') {
  globalForEvents.updateEvents = updateEvents;
}
