import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { RequestActivityMonitor } from './request-activity-monitor';

export function useUserRequests({ projectId }: { projectId: string }) {
  const monitor = useMemo(
    () => new RequestActivityMonitor(`${process.env.NEXT_PUBLIC_API_BASE ?? ''}/api/chat/${projectId}/requests/active`),
    [projectId]
  );
  const state = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, monitor.getSnapshot);

  useEffect(() => {
    monitor.activate();
    return monitor.dispose;
  }, [monitor]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let schedule = 0;
    const poll = async (version: number) => {
      if (disposed || document.hidden || !projectId) return;
      await monitor.refresh();
      if (!disposed && !document.hidden && version === schedule) {
        timer = setTimeout(() => void poll(version), state.hasActiveRequests ? 1_500 : 5_000);
      }
    };
    const onVisibility = () => {
      schedule += 1;
      clearTimeout(timer);
      if (document.hidden) monitor.cancelPending();
      else void poll(schedule);
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    return () => {
      disposed = true;
      clearTimeout(timer);
      monitor.cancelPending();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectId, monitor, state.hasActiveRequests]);

  const createRequest = useCallback(
    (requestId: string, _messageId: string, _instruction: string, _type: 'act' | 'chat' = 'act') => {
      monitor.register(requestId);
      void monitor.refresh();
    },
    [monitor]
  );
  const startRequest = useCallback(
    (requestId: string) => {
      monitor.register(requestId);
      void monitor.refresh();
    },
    [monitor]
  );
  const completeRequest = useCallback(
    (requestId: string, _isSuccessful: boolean, _errorMessage?: string) => {
      monitor.complete(requestId);
      void monitor.refresh();
    },
    [monitor]
  );

  return { ...state, createRequest, startRequest, completeRequest };
}
