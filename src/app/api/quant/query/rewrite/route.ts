import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';
import { rewriteQuantQuery } from '@/lib/quant/query-rewrite';
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
  quotaErrorResponse,
  recordQuotaUsage,
  releaseQuotaReservation,
  reserveQuota,
  settleQuotaReservation,
} from '@/lib/quota';

const MAX_QUERY_LENGTH = 2_000;

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    {
      success: false,
      error: { code, message, retryable: false },
    },
    { status },
  );
}

function operationStateResponse(code: string, message: string, retryAfter?: number) {
  return NextResponse.json(
    { success: false, error: { code, message, retryable: code === 'IDEMPOTENCY_IN_PROGRESS' } },
    {
      status: 409,
      ...(retryAfter ? { headers: { 'Retry-After': String(Math.min(30, retryAfter)) } } : {}),
    },
  );
}

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('INVALID_JSON', '请求体必须是有效的 JSON。', 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('INVALID_REQUEST', '请求体必须是 JSON 对象。', 400);
  }

  const input = body as Record<string, unknown>;
  const query = typeof input.query === 'string' ? input.query.normalize('NFKC').trim() : '';
  const requestedCapabilityId = typeof input.requestedCapabilityId === 'string'
    ? input.requestedCapabilityId.trim()
    : null;
  const purpose = input.purpose === 'execution' ? 'execution' : 'preview';
  if (
    input.purpose !== undefined &&
    input.purpose !== 'preview' &&
    input.purpose !== 'execution'
  ) {
    return errorResponse('INVALID_PURPOSE', 'purpose 必须是 preview 或 execution。', 400);
  }
  const requestedModel = typeof input.model === 'string' ? input.model.trim() : null;

  let actionContext: Awaited<ReturnType<typeof requireAction>>;
  try {
    actionContext = await requireAction({
      headers: request.headers,
      action: purpose === 'execution' ? 'quant.query.rewrite.llm' : 'quant.data.read',
    });
  } catch (error) {
    return authErrorResponse(error);
  }

  if (query.length < 2 || query.length > MAX_QUERY_LENGTH) {
    return errorResponse(
      'INVALID_QUERY',
      `query 长度必须在 2 到 ${MAX_QUERY_LENGTH} 个字符之间。`,
      400,
    );
  }

  const requestedIdempotencyKey = (
    request.headers.get('idempotency-key') ??
    (typeof input.requestId === 'string' ? input.requestId : '')
  ).trim();
  const hasExplicitIdempotencyKey = isExplicitIdempotencyKey(requestedIdempotencyKey);
  const requestId = hasExplicitIdempotencyKey
    ? normalizeIdempotencyKey(requestedIdempotencyKey)
    : randomUUID();
  const publicRequestId = hasExplicitIdempotencyKey
    ? requestedIdempotencyKey
    : requestId;
  let operationHandle: ApiOperationHandle | null = null;
  const persistOperation = hasExplicitIdempotencyKey || (purpose === 'execution' && Boolean(actionContext.session));
  if (persistOperation) {
    try {
      const operation = await claimApiOperation({
        scope: 'quant-query-rewrite',
        actorKey: actionContext.session?.user.id ?? 'anonymous',
        idempotencyKey: requestId,
        payload: { query, requestedCapabilityId, purpose, requestedModel },
        leaseSeconds: 10 * 60,
        ...(hasExplicitIdempotencyKey ? {} : { retentionSeconds: 60 * 60 }),
      });
      if (operation.state === 'in_progress') {
        return operationStateResponse(
          'IDEMPOTENCY_IN_PROGRESS',
          '相同幂等键的 Query Rewrite 正在执行，请稍后重试。',
          operation.retryAfterSeconds,
        );
      }
      if (operation.state === 'completed') {
        if (!operation.responseAvailable || operation.responseBody === null) {
          return operationStateResponse(
            'IDEMPOTENCY_RESULT_UNAVAILABLE',
            '该请求已经完成，但响应过大未进入幂等缓存；为避免重复调用模型，本次不会重新执行。',
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
        return operationStateResponse(error.code, error.message);
      }
      return errorResponse('IDEMPOTENCY_CHECK_FAILED', '暂时无法确认请求幂等状态，请稍后重试。', 503);
    }
  }
  let quotaReservationId: string | null = null;
  if (purpose === 'execution' && actionContext.session) {
    try {
      const reservation = await reserveQuota({
        actorUserId: actionContext.session.user.id,
        metric: 'query_rewrite.llm.daily',
        quantity: 1,
        idempotencyKey: `query-rewrite:${actionContext.session.user.id}:${requestId}:attempt:${operationHandle?.attempt ?? 1}`,
      });
      quotaReservationId = reservation.reservation?.id ?? null;
    } catch (error) {
      if (operationHandle) await failApiOperation({ handle: operationHandle, error }).catch(() => undefined);
      return quotaErrorResponse(error) ?? errorResponse(
        'QUOTA_CHECK_FAILED',
        '暂时无法确认 Query Rewrite 配额，请稍后重试。',
        503,
      );
    }
  }

  let data: Awaited<ReturnType<typeof rewriteQuantQuery>>;
  try {
    data = await rewriteQuantQuery(query, {
      requestedCapabilityId,
      requestedModel,
      allowLlm: purpose === 'execution',
    });
  } catch (error) {
    if (quotaReservationId) {
      await releaseQuotaReservation({ reservationId: quotaReservationId }).catch(() => undefined);
    }
    if (operationHandle) await failApiOperation({ handle: operationHandle, error }).catch(() => undefined);
    throw error;
  }

  const responseBody = {
    success: true,
    data,
    meta: {
      schemaVersion: data.schemaVersion,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      purpose,
      strategy: data.execution.strategy,
      llmStatus: data.execution.llm.status,
      safetyDecision: data.safety.decision,
      requestId: publicRequestId,
    },
  };
  const llmUsage = data.execution.llm.usage;

  if (operationHandle) {
    try {
      await completeApiOperation({
        handle: operationHandle,
        responseStatus: 200,
        responseBody,
        cacheResponse: hasExplicitIdempotencyKey,
        ...(quotaReservationId && actionContext.session
          ? {
              quotaSettlement: {
                reservationId: quotaReservationId,
                actorUserId: actionContext.session.user.id,
                metric: 'query_rewrite.llm.daily',
                actualQuantity: data.execution.llm.attempted ? 1 : 0,
                sourceType: 'query_rewrite',
                sourceId: requestId,
                usageEventIdempotencyKey: `query-rewrite:${actionContext.session.user.id}:${requestId}:attempt:${operationHandle.attempt}:request`,
                metadata: {
                  status: data.execution.llm.status,
                  strategy: data.execution.strategy,
                },
                ...(llmUsage && llmUsage.totalTokens > 0
                  ? {
                      additionalUsage: [{
                        actorUserId: actionContext.session.user.id,
                        metric: 'llm.total_tokens.monthly',
                        quantity: llmUsage.totalTokens,
                        idempotencyKey: `query-rewrite:${actionContext.session.user.id}:${requestId}:attempt:${operationHandle.attempt}:tokens`,
                        sourceType: 'query_rewrite',
                        sourceId: requestId,
                        metadata: {
                          provider: data.execution.llm.provider,
                          model: data.execution.llm.model,
                          inputTokens: llmUsage.inputTokens,
                          outputTokens: llmUsage.outputTokens,
                        },
                      }],
                    }
                  : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      // The expensive operation has already happened. Do not release its quota
      // or mark it retryable: the still-running lease blocks duplicate work.
      console.error('[Idempotency] Failed to persist Query Rewrite response:', error);
      return errorResponse(
        'IDEMPOTENCY_COMMIT_FAILED',
        'Query Rewrite 已执行，但暂时无法安全保存幂等结果，请稍后使用相同幂等键重试。',
        503,
      );
    }
  }

  if (quotaReservationId && actionContext.session) {
    const actorUserId = actionContext.session.user.id;
    try {
      await settleQuotaReservation({
        reservationId: quotaReservationId,
        actualQuantity: data.execution.llm.attempted ? 1 : 0,
        sourceType: 'query_rewrite',
        sourceId: requestId,
        usageEventIdempotencyKey: `query-rewrite:${actorUserId}:${requestId}:attempt:${operationHandle?.attempt ?? 1}:request`,
        metadata: {
          status: data.execution.llm.status,
          strategy: data.execution.strategy,
        },
      });
      if (llmUsage && llmUsage.totalTokens > 0) {
        await recordQuotaUsage({
          actorUserId,
          metric: 'llm.total_tokens.monthly',
          quantity: llmUsage.totalTokens,
          idempotencyKey: `query-rewrite:${actorUserId}:${requestId}:attempt:${operationHandle?.attempt ?? 1}:tokens`,
          sourceType: 'query_rewrite',
          sourceId: requestId,
          metadata: {
            provider: data.execution.llm.provider,
            model: data.execution.llm.model,
            inputTokens: llmUsage.inputTokens,
            outputTokens: llmUsage.outputTokens,
          },
        });
      }
      if (operationHandle) {
        await markApiOperationQuotaAccounted({
          handle: operationHandle,
          reservationId: quotaReservationId,
        });
      }
    } catch (error) {
      // The LLM call has already completed. Returning a successful rewrite
      // avoids charging again on a client retry; idempotent keys support repair.
      console.error('[Quota] Failed to settle Query Rewrite usage:', error);
    }
  }
  return NextResponse.json(responseBody);
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
