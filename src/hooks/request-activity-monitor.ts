type Activity = { hasActiveRequests: boolean; activeCount: number };
type Read = { abort: AbortController; done: Promise<void> };

/** Server-confirmed activity for one workspace; transport failures are not completion. */
export class RequestActivityMonitor {
  private state: Activity = { hasActiveRequests: false, activeCount: 0 };
  private listeners = new Set<() => void>();
  private optimisticIds = new Set<string>();
  private pending: Read | null = null;
  private active = true;

  constructor(
    private readonly endpoint: string,
    private readonly request: typeof fetch = fetch
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate = () => {
    this.active = true;
  };
  cancelPending = () => {
    this.pending?.abort.abort();
    this.pending = null;
  };
  dispose = () => {
    this.active = false;
    this.cancelPending();
  };

  private update(activeCount: number) {
    if (!this.active || activeCount === this.state.activeCount) return;
    this.state = { activeCount, hasActiveRequests: activeCount > 0 };
    this.listeners.forEach((listener) => listener());
  }

  register = (requestId: string) => {
    if (!this.active || !requestId || this.optimisticIds.has(requestId)) return;
    this.cancelPending();
    this.optimisticIds.add(requestId);
    this.update(Math.max(this.state.activeCount, this.optimisticIds.size));
  };

  complete = (requestId: string) => {
    if (!this.active) return;
    this.cancelPending();
    this.optimisticIds.delete(requestId);
    // Completion events can describe only one task. Let the server confirm the queue is idle.
  };

  refresh = (): Promise<void> => {
    if (!this.active) return Promise.resolve();
    if (this.pending) return this.pending.done;
    const read: Read = { abort: new AbortController(), done: Promise.resolve() };
    this.pending = read;
    read.done = this.read(read);
    return read.done;
  };

  private async read(read: Read) {
    try {
      const request = this.request;
      const response = await request(this.endpoint, {
        cache: 'no-store',
        signal: AbortSignal.any([read.abort.signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) return;
      const data: unknown = await response.json();
      if (!this.active || this.pending !== read || read.abort.signal.aborted) return;
      if (!data || typeof data !== 'object') return;
      const { activeCount, hasActiveRequests } = data as Partial<Activity>;
      if (
        typeof activeCount !== 'number' ||
        !Number.isSafeInteger(activeCount) ||
        activeCount < 0 ||
        typeof hasActiveRequests !== 'boolean' ||
        hasActiveRequests !== activeCount > 0
      )
        return;
      this.optimisticIds.clear();
      this.update(activeCount);
    } catch {
      // Preserve the last confirmed/locally submitted activity until a successful read.
    } finally {
      if (this.pending === read) this.pending = null;
    }
  }
}
