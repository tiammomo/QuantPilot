import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { createErrorResponse, createSuccessResponse, handleApiError } from '@/lib/utils/api-response';
import {
  quotaErrorResponse,
  releaseQuotaReservation,
  reserveQuota,
  settleQuotaReservation,
} from '@/lib/quota';
import {
  ApiIdempotencyConflictError,
  claimApiOperation,
  completeApiOperation,
  failApiOperation,
  isExplicitIdempotencyKey,
  markApiOperationQuotaAccounted,
  normalizeIdempotencyKey,
  type ApiOperationHandle,
} from '@/lib/server/api-idempotency';
import {
  getResearchAutomationDashboard,
  runDailyResearchReport,
  sendResearchReport,
  type RunDailyResearchReportOptions,
} from '@/lib/quant/research-reports';
import { assertPrivilegedMutation } from '@/lib/server/privileged-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function idempotencyStateResponse(code: string, message: string, retryAfter?: number) {
  return NextResponse.json(
    { success: false, error: code, message },
    {
      status: 409,
      ...(retryAfter ? { headers: { 'Retry-After': String(Math.min(30, retryAfter)) } } : {}),
    },
  );
}

async function executeResearchOperation(params: {
  request: NextRequest;
  actorUserId?: string;
  action: string;
  body: Record<string, unknown>;
  metric?: string;
  units?: number;
  execute: (operationKey: string) => Promise<NextResponse>;
}): Promise<NextResponse> {
  const requestedKey = typeof params.body.idempotencyKey === 'string'
    ? params.body.idempotencyKey.trim()
    : params.request.headers.get('idempotency-key')?.trim() ?? '';
  const explicitKey = isExplicitIdempotencyKey(requestedKey);
  const operationKey = explicitKey ? normalizeIdempotencyKey(requestedKey) : randomUUID();
  let operationHandle: ApiOperationHandle | null = null;

  const units = params.units ?? 0;
  const persistOperation = explicitKey || Boolean(params.actorUserId && params.metric && units > 0);
  if (persistOperation) {
    const { idempotencyKey: _omitted, ...bodyPayload } = params.body;
    try {
      const operation = await claimApiOperation({
        scope: 'research-reports',
        actorKey: params.actorUserId ?? 'anonymous',
        idempotencyKey: operationKey,
        payload: { action: params.action, body: bodyPayload },
        ...(explicitKey ? {} : { retentionSeconds: 60 * 60 }),
      });
      if (operation.state === 'in_progress') {
        return idempotencyStateResponse(
          'IDEMPOTENCY_IN_PROGRESS',
          '相同幂等键的投研任务正在执行，请稍后重试。',
          operation.retryAfterSeconds,
        );
      }
      if (operation.state === 'completed') {
        if (!operation.responseAvailable || operation.responseBody === null) {
          return idempotencyStateResponse(
            'IDEMPOTENCY_RESULT_UNAVAILABLE',
            '该投研任务已经完成，但响应过大未进入幂等缓存；为避免重复生成或推送，本次不会重新执行。',
          );
        }
        return NextResponse.json(operation.responseBody, {
          status: operation.responseStatus,
          headers: { 'Idempotency-Replayed': 'true' },
        });
      }
      operationHandle = operation.handle;
    } catch (error) {
      if (error instanceof ApiIdempotencyConflictError) {
        return idempotencyStateResponse(error.code, error.message);
      }
      throw error;
    }
  }

  let reservationId: string | null = null;
  if (params.actorUserId && params.metric && units > 0) {
    try {
      const reserved = await reserveQuota({
        actorUserId: params.actorUserId,
        metric: params.metric,
        quantity: units,
        idempotencyKey: `research:${params.actorUserId}:${params.action}:${operationKey}:attempt:${operationHandle?.attempt ?? 1}`,
      });
      reservationId = reserved.reservation?.id ?? null;
    } catch (error) {
      if (operationHandle) await failApiOperation({ handle: operationHandle, error }).catch(() => undefined);
      throw error;
    }
  }

  let response: NextResponse;
  try {
    response = await params.execute(operationKey);
  } catch (error) {
    if (reservationId) await releaseQuotaReservation({ reservationId }).catch(() => undefined);
    if (operationHandle) await failApiOperation({ handle: operationHandle, error }).catch(() => undefined);
    throw error;
  }
  if (!response.ok) {
    const businessError = new Error(`Research operation returned HTTP ${response.status}.`);
    if (reservationId) await releaseQuotaReservation({ reservationId }).catch(() => undefined);
    if (operationHandle) await failApiOperation({ handle: operationHandle, error: businessError }).catch(() => undefined);
    return response;
  }

  if (operationHandle) {
    try {
      await completeApiOperation({
        handle: operationHandle,
        responseStatus: response.status,
        responseBody: await response.clone().json(),
        cacheResponse: explicitKey,
        ...(reservationId && params.actorUserId && params.metric
          ? {
              quotaSettlement: {
                reservationId,
                actorUserId: params.actorUserId,
                metric: params.metric,
                actualQuantity: units,
                sourceType: params.action === 'send-latest-report'
                  ? 'research_report_send'
                  : 'research_report',
                sourceId: operationKey,
                usageEventIdempotencyKey: `research:${params.actorUserId}:${params.action}:${operationKey}:attempt:${operationHandle.attempt}:usage`,
                metadata: { action: params.action, attempt: operationHandle.attempt },
              },
            }
          : {}),
      });
    } catch (error) {
      console.error('[Idempotency] Failed to persist research response:', error);
      return createErrorResponse(
        'Failed to safely persist idempotent research result',
        '投研任务已执行，但暂时无法安全保存幂等结果，请稍后使用相同幂等键重试。',
        503,
      );
    }
  }

  if (reservationId && params.actorUserId && params.metric) {
    try {
      await settleQuotaReservation({
        reservationId,
        actualQuantity: units,
        sourceType: params.action === 'send-latest-report' ? 'research_report_send' : 'research_report',
        sourceId: operationKey,
        usageEventIdempotencyKey: `research:${params.actorUserId}:${params.action}:${operationKey}:attempt:${operationHandle?.attempt ?? 1}:usage`,
        metadata: { action: params.action, attempt: operationHandle?.attempt ?? 1 },
      });
      if (operationHandle) {
        await markApiOperationQuotaAccounted({ handle: operationHandle, reservationId });
      }
    } catch (error) {
      console.error('[Quota] Failed to settle research usage:', error);
    }
  }
  return response;
}

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'research.report.read' });
    const dashboard = await getResearchAutomationDashboard();
    return createSuccessResponse(dashboard);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return handleApiError(error, 'research-reports:get', 'Failed to load research reports');
  }
}

export async function POST(request: NextRequest) {
  try {
    // Preserve the existing loopback/admin-token boundary for deployments that
    // deliberately disable user authentication. Authenticated mode delegates
    // access through the capability policy below.
    if (!getProjectAuthConfig().enabled) assertPrivilegedMutation(request);
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      watchlistId?: string;
      reportId?: string;
      dryRun?: boolean;
      confirmed?: boolean;
      idempotencyKey?: string;
    };

    if (!body.action || body.action === 'run-daily-report') {
      const context = await requireAction({ headers: request.headers, action: 'research.report.run' });
      const options: RunDailyResearchReportOptions = {
        watchlistId: body.watchlistId,
        dryRun: body.dryRun ?? true,
      };
      return await executeResearchOperation({
        request,
        actorUserId: context?.session?.user.id,
        action: 'run-daily-report',
        body,
        metric: 'research.report_runs.daily',
        units: 1,
        execute: async () => createSuccessResponse(await runDailyResearchReport(options), 201),
      });
    }

    if (body.action === 'send-latest-report') {
      const context = await requireAction({ headers: request.headers, action: 'research.report.send' });
      if (body.dryRun !== true && body.confirmed !== true) {
        throw new Error('真实推送必须显式确认。');
      }
      if (body.dryRun !== true && !body.idempotencyKey?.trim()) {
        throw new Error('真实推送必须提供幂等键。');
      }
      return await executeResearchOperation({
        request,
        actorUserId: context?.session?.user.id,
        action: 'send-latest-report',
        body,
        metric: body.dryRun === true ? undefined : 'research.report_sends.daily',
        units: body.dryRun === true ? 0 : 1,
        execute: async (operationKey) => createSuccessResponse(await sendResearchReport({
          reportId: body.reportId,
          dryRun: body.dryRun ?? false,
          // Scope the lower-level delivery fence by actor so two users may use
          // the same client key without suppressing each other's delivery.
          idempotencyKey: `${context?.session?.user.id ?? 'anonymous'}:${operationKey}`,
        }), 201),
      });
    }

    throw new Error(`Invalid research report action: ${body.action}`);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    const quotaResponse = quotaErrorResponse(error);
    if (quotaResponse) return quotaResponse;
    return handleApiError(error, 'research-reports:post', 'Failed to run research report');
  }
}
