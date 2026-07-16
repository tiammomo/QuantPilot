import { NextRequest, NextResponse } from 'next/server';
import { rewriteQuantQuery } from '@/lib/quant/query-rewrite';

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

  if (query.length < 2 || query.length > MAX_QUERY_LENGTH) {
    return errorResponse(
      'INVALID_QUERY',
      `query 长度必须在 2 到 ${MAX_QUERY_LENGTH} 个字符之间。`,
      400,
    );
  }

  const data = await rewriteQuantQuery(query, {
    requestedCapabilityId,
    requestedModel,
    allowLlm: purpose === 'execution',
  });
  return NextResponse.json({
    success: true,
    data,
    meta: {
      schemaVersion: data.schemaVersion,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      purpose,
      strategy: data.execution.strategy,
      llmStatus: data.execution.llm.status,
      safetyDecision: data.safety.decision,
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
