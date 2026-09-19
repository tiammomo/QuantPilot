import path from 'path';
import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import {
  deriveQuantGenerationTerminalSnapshot,
  requiresPiAgentMissionAcceptance,
  reconcileGenerationDispatchState,
} from '@/lib/quant/generation-terminal';
import { readQuantGenerationState } from '@/lib/quant/generation-state';
import { readQuantValidationReport } from "@/lib/quant/validation/reports";
import { readPiAgentAcceptedMissionSnapshot } from '@/lib/services/pi-agent-mission-store';
import { getProjectById } from '@/lib/services/project';
import { listPiAgentGenerationJobs, reconcileExpiredPiAgentGenerationJobs } from '@/lib/services/pi-agent-generation-dispatch-store';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('project', _request.method),
      projectId: project_id,
    });
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
    const [{ previewManager }, projectedGeneration, validation, jobs] = await Promise.all([
      import('@/lib/services/preview'),
      readQuantGenerationState(projectPath),
      readQuantValidationReport(projectPath),
      reconcileExpiredPiAgentGenerationJobs({ projectId: project_id })
        .then(() => listPiAgentGenerationJobs(project_id, 1)),
    ]);
    const generation = reconcileGenerationDispatchState(projectedGeneration, jobs[0] ?? null);
    const preview = await previewManager.getReconciledStatus(
      project_id,
      project.previewUrl,
      project.previewPort,
    );
    const acceptedMission =
      generation?.requestId && requiresPiAgentMissionAcceptance(generation)
        ? await readPiAgentAcceptedMissionSnapshot(
            project_id,
            generation.requestId,
          )
        : null;
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation,
      validation,
      preview,
      acceptedMission,
      persistedPreviewUrl: project.previewUrl,
    });

    return NextResponse.json({ success: true, data: snapshot });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to reconcile generation terminal status:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to reconcile generation status',
        ...(process.env.NODE_ENV !== 'production'
          ? {
              detail:
                error instanceof Error ? error.message : String(error),
            }
          : {}),
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
