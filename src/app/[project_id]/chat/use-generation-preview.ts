'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { GenerationPreviewController } from './generation-preview-controller';

export function useGenerationPreview({
  projectId,
  isVisualCheck,
  hasActiveRequests,
  onReveal,
}: {
  projectId: string;
  isVisualCheck: boolean;
  hasActiveRequests: boolean;
  onReveal: () => void;
}) {
  const [currentRoute, setCurrentRoute] = useState('/');
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const controller = useMemo(
    () =>
      new GenerationPreviewController({
        projectId,
        isVisualCheck,
        apiBase: process.env.NEXT_PUBLIC_API_BASE ?? '',
        onReveal: () => {
          setCurrentRoute('/');
          onReveal();
        },
        onAccepted: () => localStorage.setItem(`project_${projectId}_taskComplete`, 'true'),
      }),
    [projectId, isVisualCheck, onReveal]
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    controller.activate();
    return controller.dispose;
  }, [controller]);
  useEffect(() => {
    controller.hasActiveRequests = hasActiveRequests;
  }, [controller, hasActiveRequests]);
  const busy = state.isRunning || hasActiveRequests;
  useEffect(() => {
    void controller.reconcile();
    const timer = window.setInterval(() => void controller.reconcile(), busy || !state.previewUrl ? 2_000 : 10_000);
    return () => window.clearInterval(timer);
  }, [controller, busy, state.previewUrl]);

  const navigateToRoute = useCallback(
    (route: string) => {
      if (!state.previewUrl || !iframeRef.current) return;
      const normalized = route.startsWith('/') ? route : `/${route}`;
      iframeRef.current.src = `${state.previewUrl.split('?')[0]}${normalized}`;
      setCurrentRoute(normalized);
    },
    [state.previewUrl]
  );
  const refreshPreview = useCallback(() => {
    if (!state.previewUrl || !iframeRef.current) return;
    const normalized = currentRoute.startsWith('/') ? currentRoute : `/${currentRoute}`;
    try {
      const url = new URL(state.previewUrl.split('?')[0] + normalized, window.location.origin);
      url.searchParams.set('_ts', Date.now().toString());
      iframeRef.current.src = url.toString();
    } catch (error) {
      console.warn('Failed to refresh preview:', error);
    }
  }, [state.previewUrl, currentRoute]);

  return {
    ...state,
    controller,
    currentRoute,
    setCurrentRoute,
    iframeRef,
    navigateToRoute,
    refreshPreview,
    start: controller.start,
    stop: controller.stop,
    setIsRunning: controller.setRunning,
    setAgentWorkComplete: controller.setWorkComplete,
    setPreviewInitializationMessage: controller.setMessage,
  };
}
