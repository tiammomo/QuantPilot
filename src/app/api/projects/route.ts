/**
 * Projects API Routes
 * GET /api/projects - Get all projects
 * POST /api/projects - Create new project
 */

import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';
import { getAllProjects, createProject } from '@/lib/services/project';
import type { CreateProjectInput } from '@/types/backend';
import { serializeProjects, serializeProject } from '@/lib/serializers/project';
import { normalizeMoAgentModelId } from '@/lib/constants/models';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { getQuantCapability } from '@/lib/quant/capabilities';
import { getProjectAuthConfig } from '@/lib/config/auth';
import {
  AuthorizationError,
  requireAuthSession,
  isPlatformAdmin,
} from '@/lib/auth/authorization';
import { requireAction } from '@/lib/auth/action';
import { PrismaPermissionPolicyRepository } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';
import {
  PermissionDeniedError,
  requirePermissionWithRepository,
} from '@/lib/auth/permissions';
import type { ProjectAuthSession } from '@/lib/auth/server';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import {
  quotaErrorResponse,
  releaseQuotaReservation,
  reserveQuota,
  settleQuotaReservation,
} from '@/lib/quota';

async function requireProjectListPermission(session: ProjectAuthSession | null): Promise<void> {
  if (!session || isPlatformAdmin(session.user)) return;
  try {
    await requirePermissionWithRepository({
      action: 'project.read',
      actor: { id: session.user.id, platformRole: 'member' },
      // Listing is already constrained to owned/member projects. Viewer is the
      // minimum role and therefore the correct role intersection for a list.
      project: { id: 'project-list', role: 'viewer' },
    }, new PrismaPermissionPolicyRepository());
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      throw new AuthorizationError(
        'CAPABILITY_DENIED',
        403,
        '当前用户缺少查看项目列表所需的能力权限。',
      );
    }
    throw error;
  }
}

/**
 * GET /api/projects
 * Get all projects list
 */
export async function GET(request: NextRequest) {
  try {
    const session = getProjectAuthConfig().enabled
      ? await requireAuthSession(request.headers)
      : null;
    await requireProjectListPermission(session);
    const projects = await getAllProjects(session ? {
      userId: session.user.id,
      isAdmin: isPlatformAdmin(session.user),
    } : undefined);
    return createSuccessResponse(serializeProjects(projects));
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return handleApiError(error, 'API', 'Failed to fetch projects');
  }
}

/**
 * POST /api/projects
 * Create new project
 */
export async function POST(request: NextRequest) {
  let quotaReservationId: string | null = null;
  let projectCreated = false;
  try {
    const actionContext = await requireAction({
      headers: request.headers,
      action: 'project.create',
    });
    const session = actionContext.session;
    const body = await request.json();
    const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
    const projectName = typeof body.name === 'string' ? body.name.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)) {
      return createErrorResponse(
        'INVALID_PROJECT_ID',
        'project_id 只能包含字母、数字、下划线和连字符，长度为 1 到 100。',
        400,
      );
    }
    if (!projectName || projectName.length > 120) {
      return createErrorResponse('INVALID_PROJECT_NAME', 'name 长度必须为 1 到 120。', 400);
    }
    const quantCapability = getQuantCapability(
      body.quantCapabilityId || body.quant_capability_id || body.capabilityId || body.capability_id
    );

    const input: CreateProjectInput = {
      project_id: projectId,
      name: projectName,
      initialPrompt: body.initialPrompt || body.initial_prompt,
      preferredCli: 'moagent',
      selectedModel: normalizeMoAgentModelId(body.selectedModel ?? body.selected_model),
      description: body.description,
      quantCapabilityId: quantCapability.id,
      quantCapabilitySource:
        body.quantCapabilitySource || body.quant_capability_source || body.capabilitySource || body.capability_source,
    };

    if (session) {
      const suppliedOperationKey = request.headers.get('idempotency-key')?.trim() ?? '';
      const operationKey = /^[A-Za-z0-9._:-]{1,120}$/.test(suppliedOperationKey)
        ? suppliedOperationKey
        : randomUUID();
      const quota = await reserveQuota({
        actorUserId: session.user.id,
        metric: 'projects.owned',
        quantity: 1,
        idempotencyKey: `project-create:${session.user.id}:${operationKey}`,
        reservationTtlSeconds: 3_600,
      });
      if (
        !quota.reservation ||
        quota.reservation.status !== 'active' ||
        quota.reservation.idempotent
      ) {
        return createErrorResponse(
          'PROJECT_CREATE_OPERATION_ALREADY_USED',
          '该项目创建操作正在执行或已经结束；请读取原操作结果，重新创建时使用新的幂等键。',
          409,
        );
      }
      quotaReservationId = quota.reservation.id;
    }

    const project = await createProject(
      input,
      session ? { ownerId: session.user.id } : undefined,
    );
    projectCreated = true;
    if (quotaReservationId) {
      try {
        await settleQuotaReservation({
          reservationId: quotaReservationId,
          actualQuantity: 1,
          sourceType: 'project',
          sourceId: project.id,
          usageEventIdempotencyKey: `project:${project.id}:${project.createdAt.getTime()}:owned`,
        });
      } catch (quotaError) {
        // Project creation is already committed. Keep the user-visible result
        // successful and leave an idempotent reservation for reconciliation.
        console.error('[Quota] Failed to settle project ownership usage:', quotaError);
      }
    }
    if (session) {
      void writeAuthAuditEvent({
        actorUserId: session.user.id,
        eventType: 'project.created',
        targetType: 'project',
        targetId: project.id,
        outcome: 'success',
        headers: request.headers,
      });
    }
    return createSuccessResponse(serializeProject(project), 201);
  } catch (error) {
    if (quotaReservationId && !projectCreated) {
      await releaseQuotaReservation({ reservationId: quotaReservationId }).catch((releaseError) => {
        console.error('[Quota] Failed to release project creation reservation:', releaseError);
      });
    }
    const quotaResponse = quotaErrorResponse(error);
    if (quotaResponse) return quotaResponse;
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return handleApiError(error, 'API', 'Failed to create project');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
