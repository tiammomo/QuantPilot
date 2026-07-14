import path from 'path';
import { NextResponse } from 'next/server';
import { deriveQuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';
import { readQuantGenerationState } from '@/lib/quant/generation-state';
import { readQuantValidationReport } from '@/lib/quant/validation';
import { getProjectById } from '@/lib/services/project';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 },
      );
    }

    const projectPath = project.repoPath
      ? path.resolve(/* turbopackIgnore: true */ project.repoPath)
      : path.resolve(
          /* turbopackIgnore: true */ process.cwd(),
          process.env.PROJECTS_DIR || './data/projects',
          project_id,
        );
    const [{ previewManager }, generation, validation] = await Promise.all([
      import('@/lib/services/preview'),
      readQuantGenerationState(projectPath),
      readQuantValidationReport(projectPath),
    ]);
    const preview = previewManager.getStatus(project_id);
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation,
      validation,
      preview,
      persistedPreviewUrl: project.previewUrl,
    });

    return NextResponse.json({ success: true, data: snapshot });
  } catch (error) {
    console.error('[API] Failed to reconcile generation terminal status:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to reconcile generation status',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
