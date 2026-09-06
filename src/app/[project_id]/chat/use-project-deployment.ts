'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';
type DeploymentStatus = 'idle' | 'deploying' | 'ready' | 'error';
type Connection = { provider: string; service_data?: { last_deployment_url?: string } };
type Deployment = {
  has_deployment?: boolean;
  ready?: boolean;
  status?: string;
  deployment_id?: string;
  deployment_url?: string;
  last_deployment_url?: string;
};
const normalizeUrl = (url?: string) => (url ? (url.startsWith('http') ? url : `https://${url}`) : null);

export function useProjectDeployment(projectId: string) {
  const [showPublishPanel, setShowPublishPanel] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [vercelConnected, setVercelConnected] = useState<boolean | null>(null);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus>('idle');
  const scope = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const monitorVersion = useRef(0);
  const publishing = useRef(false);

  const request = useCallback(
    async <T>(path: string, controller: AbortController, init?: RequestInit): Promise<T> => {
      controller.signal.throwIfAborted();
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/${path}`, {
        ...init,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as T;
      controller.signal.throwIfAborted();
      return data;
    },
    [projectId]
  );

  const monitor = useCallback(
    (controller: AbortController) => {
      const version = ++monitorVersion.current;
      if (timer.current) clearTimeout(timer.current);
      const current = () => !controller.signal.aborted && monitorVersion.current === version;
      const poll = async () => {
        if (!current()) return;
        let again = true;
        try {
          const data = await request<Deployment>('vercel/deployment/current', controller);
          if (!current()) return;
          if (data.status === 'ERROR' || data.status === 'CANCELED') {
            setDeploymentStatus('error');
            again = false;
          } else if (data.status === 'READY' || !data.has_deployment) {
            const url = normalizeUrl(data.deployment_url || data.last_deployment_url);
            setPublishedUrl(url);
            setDeploymentStatus(url ? 'ready' : 'idle');
            again = false;
          } else setDeploymentStatus('deploying');
        } catch (error) {
          if (current() && error instanceof Error && error.message.startsWith('HTTP 404:')) {
            setDeploymentStatus('idle');
            again = false;
          }
        } finally {
          if (current()) {
            if (again) timer.current = setTimeout(() => void poll(), 1000);
            else {
              publishing.current = false;
              setPublishLoading(false);
            }
          }
        }
      };
      void poll();
    },
    [request]
  );

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    scope.current = controller;
    const loadConnections = async () => {
      try {
        const connections = await request<Connection[]>('services', controller);
        setGithubConnected(connections.some((connection) => connection.provider === 'github'));
        const vercel = connections.find((connection) => connection.provider === 'vercel');
        setVercelConnected(Boolean(vercel));
        if (!publishing.current) {
          const url = normalizeUrl(vercel?.service_data?.last_deployment_url);
          setPublishedUrl(url);
          setDeploymentStatus(url ? 'ready' : 'idle');
        }
      } catch {
        if (!controller.signal.aborted) {
          setGithubConnected(false);
          setVercelConnected(false);
        }
      }
    };
    const initialize = async () => {
      await loadConnections();
      if (controller.signal.aborted) return;
      try {
        const data = await request<Deployment>('vercel/deployment/current', controller);
        if (data.has_deployment && !publishing.current) {
          publishing.current = true;
          setShowPublishPanel(true);
          setDeploymentStatus('deploying');
          monitor(controller);
        }
      } catch {
        /* No current deployment; the user may publish after connecting services. */
      }
    };
    void initialize();
    window.addEventListener('services-updated', loadConnections);
    return () => {
      controller.abort();
      monitorVersion.current += 1;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('services-updated', loadConnections);
    };
  }, [projectId, request, monitor]);

  const publish = useCallback(async () => {
    const controller = scope.current;
    if (!controller || controller.signal.aborted || publishing.current || !githubConnected || !vercelConnected) return;
    publishing.current = true;
    setPublishLoading(true);
    setDeploymentStatus('deploying');
    try {
      await request('github/push', controller, { method: 'POST' });
      // Allow the remote branch to become visible before requesting deployment.
      await new Promise((resolve) => setTimeout(resolve, 800));
      const data = await request<Deployment>('vercel/deploy', controller, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'main' }),
      });
      if ((data.ready || data.status === 'READY') && data.deployment_url) {
        setPublishedUrl(normalizeUrl(data.deployment_url));
        setDeploymentStatus('ready');
        publishing.current = false;
        setPublishLoading(false);
      } else monitor(controller);
    } catch {
      if (!controller.signal.aborted) {
        publishing.current = false;
        setPublishLoading(false);
        setDeploymentStatus('error');
      }
    }
  }, [githubConnected, vercelConnected, monitor, request]);

  return {
    showPublishPanel,
    setShowPublishPanel,
    publishLoading,
    githubConnected,
    vercelConnected,
    publishedUrl,
    deploymentStatus,
    publish,
  };
}
