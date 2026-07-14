import type { PreviewInfo } from '@/lib/services/preview';

export interface ValidatedGenerationPreview {
  url: string;
  port: number | null;
  status: 'running';
}

type StartPreview = (projectId: string) => Promise<PreviewInfo>;

export async function startPersistentValidatedPreview(params: {
  projectId: string;
  startPreview?: StartPreview;
}): Promise<ValidatedGenerationPreview> {
  const startPreview = params.startPreview ?? (async (projectId: string) => {
    const { previewManager } = await import('@/lib/services/preview');
    return previewManager.start(projectId);
  });
  const preview = await startPreview(params.projectId);

  if (preview.status !== 'running' || !preview.url) {
    throw new Error(
      `Persistent preview is not ready (status=${preview.status}, url=${preview.url ?? 'missing'}).`,
    );
  }

  return {
    url: preview.url,
    port: preview.port,
    status: 'running',
  };
}
