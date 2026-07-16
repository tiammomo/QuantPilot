import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
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
import { strategyPermissionAction } from './permission';
import {
  addStrategyUniverseMember,
  buildStrategyPrompt,
  controlStrategyIngestionJob,
  enqueueStrategyParameterScan,
  getStrategyDashboardData,
  getStrategyIngestionJobs,
  getStrategyIntradayBars,
  getStrategyRealtimeQuote,
  getStrategySectorCapitalFlow,
  getStrategySymbolBars,
  getStrategySymbolDividends,
  getStrategyUniverseMembersPage,
  ingestStrategyUniverseHistoryBatch,
  runStrategyScreener,
  runStrategyDataQualityScan,
  runStrategyParameterScan,
  startStrategyUniverseHistoryAutoFill,
} from '@/lib/quant/strategies';

const STRATEGY_DATA_UNIT_WEIGHTS: Readonly<Record<string, number>> = {
  'universe-members': 1,
  'symbol-bars': 2,
  'symbol-dividends': 1,
  'realtime-quote': 1,
  'intraday-bars': 2,
  'ingestion-jobs': 1,
  'sector-capital-flow': 3,
  'a-share-screener': 10,
  'run-scan': 10,
  'run-scan-now': 10,
  'data-quality-scan': 20,
  'run-ingestion-batch': 50,
  'start-ingestion-autofill': 100,
};

function requestedOperationKey(request: NextRequest, body?: Record<string, unknown>): string {
  return (
    request.headers.get('idempotency-key') ??
    (typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '')
  ).trim();
}

function idempotencyStateResponse(code: string, message: string, retryAfter?: number) {
  return NextResponse.json(
    { success: false, error: code, message },
    {
      status: 409,
      ...(retryAfter ? { headers: { 'Retry-After': String(Math.min(30, retryAfter)) } } : {}),
    },
  );
}

async function executeStrategyOperation(params: {
  request: NextRequest;
  actorUserId?: string;
  action: string;
  body?: Record<string, unknown>;
  units: number;
  execute: () => Promise<NextResponse>;
}): Promise<NextResponse> {
  const requestedKey = requestedOperationKey(params.request, params.body);
  const explicitKey = isExplicitIdempotencyKey(requestedKey);
  const key = explicitKey ? normalizeIdempotencyKey(requestedKey) : randomUUID();
  let operationHandle: ApiOperationHandle | null = null;

  const persistOperation = explicitKey || Boolean(params.actorUserId && params.units > 0);
  if (persistOperation) {
    const { idempotencyKey: _omitted, ...bodyPayload } = params.body ?? {};
    try {
      const operation = await claimApiOperation({
        scope: 'quant-strategies',
        actorKey: params.actorUserId ?? 'anonymous',
        idempotencyKey: key,
        payload: {
          method: params.request.method,
          action: params.action,
          body: bodyPayload,
          query: Object.fromEntries(new URL(params.request.url).searchParams.entries()),
        },
        ...(explicitKey ? {} : { retentionSeconds: 60 * 60 }),
      });
      if (operation.state === 'in_progress') {
        return idempotencyStateResponse(
          'IDEMPOTENCY_IN_PROGRESS',
          '相同幂等键的策略操作正在执行，请稍后重试。',
          operation.retryAfterSeconds,
        );
      }
      if (operation.state === 'completed') {
        if (!operation.responseAvailable || operation.responseBody === null) {
          return idempotencyStateResponse(
            'IDEMPOTENCY_RESULT_UNAVAILABLE',
            '该策略操作已经完成，但响应过大未进入幂等缓存；为避免重复取数，本次不会重新执行。',
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
  if (params.actorUserId && params.units > 0) {
    try {
      const reserved = await reserveQuota({
        actorUserId: params.actorUserId,
        metric: 'quant.data_units.daily',
        quantity: params.units,
        idempotencyKey: `strategy:${params.actorUserId}:${params.action}:${key}:attempt:${operationHandle?.attempt ?? 1}`,
      });
      reservationId = reserved.reservation?.id ?? null;
    } catch (error) {
      if (operationHandle) await failApiOperation({ handle: operationHandle, error }).catch(() => undefined);
      throw error;
    }
  }

  let response: NextResponse;
  try {
    response = await params.execute();
  } catch (error) {
    if (reservationId) await releaseQuotaReservation({ reservationId }).catch(() => undefined);
    if (operationHandle) await failApiOperation({ handle: operationHandle, error }).catch(() => undefined);
    throw error;
  }

  if (!response.ok) {
    const businessError = new Error(`Strategy operation returned HTTP ${response.status}.`);
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
        ...(reservationId && params.actorUserId
          ? {
              quotaSettlement: {
                reservationId,
                actorUserId: params.actorUserId,
                metric: 'quant.data_units.daily',
                actualQuantity: params.units,
                sourceType: 'strategy_api',
                sourceId: key,
                usageEventIdempotencyKey: `strategy:${params.actorUserId}:${params.action}:${key}:attempt:${operationHandle.attempt}:usage`,
                metadata: { action: params.action, units: params.units, attempt: operationHandle.attempt },
              },
            }
          : {}),
      });
    } catch (error) {
      console.error('[Idempotency] Failed to persist strategy response:', error);
      return createErrorResponse(
        'Failed to safely persist idempotent strategy result',
        '策略操作已执行，但暂时无法安全保存幂等结果，请稍后使用相同幂等键重试。',
        503,
      );
    }
  }

  if (reservationId && params.actorUserId) {
    try {
      await settleQuotaReservation({
        reservationId,
        actualQuantity: params.units,
        sourceType: 'strategy_api',
        sourceId: key,
        usageEventIdempotencyKey: `strategy:${params.actorUserId}:${params.action}:${key}:attempt:${operationHandle?.attempt ?? 1}:usage`,
        metadata: { action: params.action, units: params.units, attempt: operationHandle?.attempt ?? 1 },
      });
      if (operationHandle) {
        await markApiOperationQuotaAccounted({ handle: operationHandle, reservationId });
      }
    } catch (error) {
      // Business succeeded and the cached replay now prevents duplicate work.
      // Keep the reservation for reconciliation rather than releasing usage.
      console.error('[Quota] Failed to settle strategy data units:', error);
    }
  }
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const context = await requireAction({ headers: request.headers, action: 'quant.data.read' });
    return await executeStrategyOperation({
      request,
      actorUserId: context?.session?.user.id,
      action: 'dashboard',
      units: 1,
      execute: async () => createSuccessResponse(await getStrategyDashboardData()),
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    const quotaResponse = quotaErrorResponse(error);
    if (quotaResponse) return quotaResponse;
    return handleApiError(error, 'StrategyPlatform', 'Failed to fetch strategies');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const permissionAction = strategyPermissionAction(body.action);
    if (!permissionAction) {
      return createErrorResponse(
        typeof body.action === 'string'
          ? `Unsupported strategy action: ${body.action}`
          : 'Unsupported strategy action',
        undefined,
        400,
      );
    }
    const context = await requireAction({ headers: request.headers, action: permissionAction });
    return await executeStrategyOperation({
      request,
      actorUserId: context?.session?.user.id,
      action: String(body.action),
      body,
      units: STRATEGY_DATA_UNIT_WEIGHTS[String(body.action)] ?? 0,
      execute: async () => {
    if (body.action === 'run-scan') {
      return createSuccessResponse(
        await enqueueStrategyParameterScan({
          templateId: String(body.templateId ?? ''),
          scanId: String(body.scanId ?? ''),
          symbol: typeof body.symbol === 'string' ? body.symbol : undefined,
        }),
        201
      );
    }
    if (body.action === 'run-scan-now') {
      return createSuccessResponse(
        await runStrategyParameterScan({
          templateId: String(body.templateId ?? ''),
          scanId: String(body.scanId ?? ''),
          symbol: typeof body.symbol === 'string' ? body.symbol : undefined,
        }),
        201
      );
    }
    if (body.action === 'add-universe-member') {
      return createSuccessResponse(
        await addStrategyUniverseMember({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          query: String(body.query ?? ''),
          syncHistory: body.syncHistory === true,
        }),
        201
      );
    }
    if (body.action === 'universe-members') {
      return createSuccessResponse(
        await getStrategyUniverseMembersPage({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          page: typeof body.page === 'number' ? body.page : undefined,
          pageSize: typeof body.pageSize === 'number' ? body.pageSize : undefined,
          keyword: typeof body.keyword === 'string' ? body.keyword : undefined,
        })
      );
    }
    if (body.action === 'symbol-bars') {
      return createSuccessResponse(
        await getStrategySymbolBars({
          symbol: String(body.symbol ?? ''),
          timeframe: typeof body.timeframe === 'string' ? body.timeframe : undefined,
          adjustment: typeof body.adjustment === 'string' ? body.adjustment : undefined,
          provider: typeof body.provider === 'string' ? body.provider : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          includeMetadata: body.includeMetadata === true,
        })
      );
    }
    if (body.action === 'symbol-dividends') {
      return createSuccessResponse(
        await getStrategySymbolDividends({
          symbol: String(body.symbol ?? ''),
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
      );
    }
    if (body.action === 'realtime-quote') {
      return createSuccessResponse(
        await getStrategyRealtimeQuote({
          symbol: String(body.symbol ?? ''),
        })
      );
    }
    if (body.action === 'intraday-bars') {
      return createSuccessResponse(
        await getStrategyIntradayBars({
          symbol: String(body.symbol ?? ''),
          period: typeof body.period === 'string' ? body.period : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          refresh: body.refresh === true || body.forceRefresh === true,
        })
      );
    }
    if (body.action === 'ingestion-jobs') {
      return createSuccessResponse(
        await getStrategyIngestionJobs({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
      );
    }
    if (body.action === 'control-ingestion-job') {
      const action = String(body.control ?? body.controlAction ?? '');
      if (!['pause', 'resume', 'stop'].includes(action)) {
        return createErrorResponse('Unsupported ingestion control action', undefined, 400);
      }
      return createSuccessResponse(
        await controlStrategyIngestionJob({
          jobId: String(body.jobId ?? ''),
          action: action as 'pause' | 'resume' | 'stop',
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        })
      );
    }
    if (body.action === 'sector-capital-flow') {
      return createSuccessResponse(
        await getStrategySectorCapitalFlow({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          sector: typeof body.sector === 'string' ? body.sector : undefined,
          detailDays: typeof body.detailDays === 'number' ? body.detailDays : undefined,
        })
      );
    }
    if (body.action === 'a-share-screener') {
      const mode = typeof body.mode === 'string' ? body.mode : undefined;
      return createSuccessResponse(
        await runStrategyScreener({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          tradeDate: typeof body.tradeDate === 'string' ? body.tradeDate : undefined,
          mode: mode === 'limit_up_relay' || mode === 'trend_liquidity' || mode === 'short_term'
            ? mode
            : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
        })
      );
    }
    if (body.action === 'data-quality-scan') {
      return createSuccessResponse(
        await runStrategyDataQualityScan({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          symbols: Array.isArray(body.symbols)
            ? body.symbols.map((item: unknown) => String(item)).filter(Boolean)
            : undefined,
          timeframe: typeof body.timeframe === 'string' ? body.timeframe : undefined,
          adjustment: typeof body.adjustment === 'string' ? body.adjustment : undefined,
          lookbackYears: typeof body.lookbackYears === 'number' ? body.lookbackYears : undefined,
          persist: body.persist !== false,
        }),
        201
      );
    }
    if (body.action === 'run-ingestion-batch') {
      return createSuccessResponse(
        await ingestStrategyUniverseHistoryBatch({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          offset: typeof body.offset === 'number' ? body.offset : undefined,
          batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          lookbackYears: typeof body.lookbackYears === 'number' ? body.lookbackYears : undefined,
          start: typeof body.start === 'string' ? body.start : undefined,
          end: typeof body.end === 'string' ? body.end : undefined,
          period: typeof body.period === 'string' ? body.period : undefined,
          adjustment: typeof body.adjustment === 'string' ? body.adjustment : undefined,
          includeValuationFactors:
            body.includeValuationFactors === true || body.include_valuation_factors === true,
        }),
        201
      );
    }
    if (body.action === 'start-ingestion-autofill') {
      return createSuccessResponse(
        await startStrategyUniverseHistoryAutoFill({
          universeId: typeof body.universeId === 'string' ? body.universeId : undefined,
          offset: typeof body.offset === 'number' ? body.offset : undefined,
          batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
          limit: typeof body.limit === 'number' ? body.limit : undefined,
          lookbackYears: typeof body.lookbackYears === 'number' ? body.lookbackYears : undefined,
          start: typeof body.start === 'string' ? body.start : undefined,
          end: typeof body.end === 'string' ? body.end : undefined,
          period: typeof body.period === 'string' ? body.period : undefined,
          adjustment: typeof body.adjustment === 'string' ? body.adjustment : undefined,
          maxBatches: typeof body.maxBatches === 'number' ? body.maxBatches : undefined,
          includeValuationFactors:
            body.includeValuationFactors === true || body.include_valuation_factors === true,
        }),
        201
      );
    }
        return createSuccessResponse(buildStrategyPrompt(String(body.templateId ?? ''), body.symbol), 201);
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    const quotaResponse = quotaErrorResponse(error);
    if (quotaResponse) return quotaResponse;
    return handleApiError(error, 'StrategyPlatform', 'Failed to build strategy prompt');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
