import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { cancelAgentRuns } from '@/lib/services/agent-runtime';
import {
  assertUserRequestProjectBinding,
  markActiveUserRequestsAsCancelled,
  markUserRequestAsCancelled,
  UserRequestProjectMismatchError,
} from '@/lib/services/user-requests';
import { streamManager } from '@/lib/services/stream';
import { getProjectById } from '@/lib/services/project';
import { markQuantGenerationQueueCancelled } from '@/lib/quant/generation-queue';
import { cancelQuantGenerationRun } from '@/lib/quant/generation-state';
import {
  cancelActiveMoAgentMissions,
  cancelMoAgentMission,
  readMoAgentMission,
} from '@/lib/services/moagent-mission-store';
import path from 'path';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('agent-cancel', request.method),
      projectId: project_id,
    });
    const body = await request.json().catch(() => ({}));
    const requestId =
      typeof body.requestId === 'string' && body.requestId.trim()
        ? body.requestId.trim()
        : undefined;
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : '用户暂停了当前任务';

    if (requestId) {
      try {
        const exists = await assertUserRequestProjectBinding(project_id, requestId);
        if (!exists) {
          return NextResponse.json(
            { success: false, error: 'Request not found for this project' },
            { status: 404 },
          );
        }
      } catch (error) {
        if (error instanceof UserRequestProjectMismatchError) {
          return NextResponse.json(
            { success: false, error: 'Request ID belongs to a different project' },
            { status: 409 },
          );
        }
        throw error;
      }
    }

    const result = cancelAgentRuns(project_id, requestId, reason);
    let cancelledMissions = 0;
    if (requestId) {
      await markUserRequestAsCancelled(project_id, requestId, reason);
      const mission = await readMoAgentMission(project_id, requestId);
      if (mission) {
        const cancelled = await cancelMoAgentMission({
          missionId: mission.id,
          projectId: project_id,
          requestId,
          message: reason,
        });
        cancelledMissions = cancelled.status === 'cancelled' ? 1 : 0;
      }
      const project = await getProjectById(project_id);
      if (project) {
        const projectsDir = process.env.PROJECTS_DIR || './data/projects';
        const projectPath = project.repoPath
          ? path.isAbsolute(project.repoPath)
            ? project.repoPath
            : path.resolve(/*turbopackIgnore: true*/ process.cwd(), project.repoPath)
          : path.resolve(/*turbopackIgnore: true*/ process.cwd(), projectsDir, project_id);
        await markQuantGenerationQueueCancelled({
          projectPath,
          projectId: project_id,
          requestId,
          reason,
        }).catch((error) => {
          console.warn('[API] Failed to mark generation queue item cancelled:', error);
        });
        await cancelQuantGenerationRun({
          projectPath,
          projectId: project_id,
          requestId,
          reason,
        }).catch((error) => {
          console.warn('[API] Failed to mark generation state cancelled:', error);
        });
      }
    } else {
      await markActiveUserRequestsAsCancelled(project_id, reason);
      cancelledMissions = await cancelActiveMoAgentMissions({
        projectId: project_id,
        message: reason,
      });
    }

    const cancellation = { ...result, cancelledMissions };

    streamManager.publish(project_id, {
      type: 'status',
      data: {
        status: 'agent_paused',
        message: reason,
        ...(requestId ? { requestId } : {}),
        metadata: cancellation,
      },
    });

    return NextResponse.json({
      success: true,
      data: cancellation,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to pause agent:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to pause agent',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
