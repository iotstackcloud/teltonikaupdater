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

    return () => {
      this.listeners.get(jobId)?.delete(callback);
    };
  }

  subscribeAll(callback: EventCallback): () => void {
    this.globalListeners.add(callback);
    return () => {
      this.globalListeners.delete(callback);
    };
  }

  emit(event: UpdateEvent): void {
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
}

export const updateEvents = new UpdateEventEmitter();
