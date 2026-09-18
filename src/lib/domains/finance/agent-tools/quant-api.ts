import { createHash } from 'node:crypto';
import type { PiAgentTool } from '@/lib/agent/types';
import type { DataAgentSourceReceipt } from '@/lib/data-agent/contracts';
import { assessQuantDataResponse } from '../data-quality';
import { compactQuantOutput } from './quant-api-output';
import { PiAgentToolError, throwIfAborted } from '@/lib/agent/tools/errors';
import { inputRecord, requiredString } from '@/lib/agent/tools/input';
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executePiAgentTool,
} from '@/lib/agent/tools/runtime';

const QUANT_API_ORIGIN = 'http://127.0.0.1:8000';
const QUANT_API_PREFIX = '/api/v1/';
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_REQUESTS = 32;
const MAX_URL_CHARS = 8_192;
const ALLOWED_QUANT_API_PATHS = [
  /^\/api\/v1\/registry$/,
  /^\/api\/v1\/symbols\/resolve$/,
  /^\/api\/v1\/quotes\/(?:realtime(?:\/[^/]+)?|history\/[^/]+)$/,
  /^\/api\/v1\/research\/(?:universes\/summary|universes\/[^/]+\/members|data-coverage|bars\/[^/]+|screeners\/a-share\/short-term-candidates|sector-capital-flow)$/,
  /^\/api\/v1\/fundamentals\/financials\/[^/]+$/,
  /^\/api\/v1\/indicators\/(?:technical|fundamental)\/[^/]+$/,
  /^\/api\/v1\/events\/(?:announcements|dividends)\/[^/]+$/,
  /^\/api\/v1\/backtests\/(?:ma-crossover\/[^/]+|strategies\/[^/]+\/[^/]+)$/,
  /^\/api\/v1\/foundation\/(?:status|factors|trading-calendar)$/,
  /^\/api\/v1\/analytics\/clickhouse\/health$/,
] as const;

type QueryPrimitive = string | number | boolean;
type QueryValue = QueryPrimitive | QueryPrimitive[];
export interface QuantApiGetInput {
  path: string;
  query: Record<string, QueryValue>;
}

export interface PiAgentQuantApiToolOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  maxResponseBytes?: number;
  maxRequests?: number;
  /** Dependency injection for tests; the destination URL remains fixed. */
  fetchImpl?: typeof fetch;
}

function validateQueryValue(value: unknown, key: string): QueryValue {
  const validPrimitive = (candidate: unknown): candidate is QueryPrimitive =>
    (typeof candidate === 'string' && candidate.length <= 2_048) || typeof candidate === 'boolean' ||
    (typeof candidate === 'number' && Number.isFinite(candidate));
  if (validPrimitive(value)) return value;
  if (Array.isArray(value) && value.length <= 100 && value.every(validPrimitive)) return value;
  throw new PiAgentToolError(
    'INVALID_TOOL_INPUT',
    `query.${key} must be a string, finite number, boolean, or an array of those values.`,
  );
}

function parseQuantApiGetInput(value: unknown): QuantApiGetInput {
  const record = inputRecord(value);
  const rawQuery = record.query === undefined ? {} : inputRecord(record.query);
  const query = Object.create(null) as Record<string, QueryValue>;
  const entries = Object.entries(rawQuery);
  if (entries.length > 100) {
    throw new PiAgentToolError('INVALID_TOOL_INPUT', 'query accepts at most 100 keys.');
  }
  for (const [key, queryValue] of entries) {
    if (!key || key.length > 200 || /[\r\n\0]/.test(key)) {
      throw new PiAgentToolError('INVALID_TOOL_INPUT', 'Query keys must be 1-200 printable characters.');
    }
    query[key] = validateQueryValue(queryValue, key);
  }
  return {
    path: requiredString(record, 'path', { maxLength: 2_048 }),
    query,
  };
}

function buildQuantApiUrl(apiPath: string, query: Record<string, QueryValue>): URL {
  if (!apiPath.startsWith(QUANT_API_PREFIX) || apiPath.startsWith('//')) {
    throw new PiAgentToolError(
      'QUANT_API_PATH_DENIED',
      'quant_api_get only accepts paths beginning with /api/v1/.',
    );
  }
  if (apiPath.includes('\\') || apiPath.includes('?') || apiPath.includes('#') || /[\r\n\0]/.test(apiPath)) {
    throw new PiAgentToolError('QUANT_API_PATH_DENIED', 'The API path must not contain query text, fragments, backslashes, or control characters.');
  }
  const rawSegments = apiPath.split('/');
  for (const rawSegment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new PiAgentToolError('QUANT_API_PATH_DENIED', 'The API path contains malformed percent encoding.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new PiAgentToolError('QUANT_API_PATH_DENIED', 'API path traversal and encoded separators are denied.');
    }
  }

  const url = new URL(apiPath, QUANT_API_ORIGIN);
  if (url.origin !== QUANT_API_ORIGIN || !url.pathname.startsWith(QUANT_API_PREFIX)) {
    throw new PiAgentToolError('QUANT_API_PATH_DENIED', 'The API request must remain on the local /api/v1/ endpoint.');
  }
  if (!ALLOWED_QUANT_API_PATHS.some((pattern) => pattern.test(url.pathname))) {
    throw new PiAgentToolError(
      'QUANT_API_ENDPOINT_DENIED',
      'The requested local API endpoint is not in the PI Agent read-only quant allowlist.',
    );
  }
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(key, String(item));
  }
  if (url.toString().length > MAX_URL_CHARS) {
    throw new PiAgentToolError('QUANT_API_URL_TOO_LONG', `Quant API URLs cannot exceed ${MAX_URL_CHARS} characters.`);
  }
  return url;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!response.body) return { text: '', truncated: false, bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel('PI Agent response byte limit reached.').catch(() => undefined);
        break;
      }
      if (result.value.byteLength > remaining) {
        chunks.push(result.value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        await reader.cancel('PI Agent response byte limit reached.').catch(() => undefined);
        break;
      }
      chunks.push(result.value);
      bytes += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  return { text, truncated, bytes };
}

export function createQuantApiGetTool(options: PiAgentQuantApiToolOptions = {}): PiAgentTool<QuantApiGetInput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let requestCount = 0;
  return {
    name: 'quant_api_get',
    description: 'GET market and quant data from the fixed local http://127.0.0.1:8000/api/v1/ service. Inconsistent or incomplete responses fail; narrow the query when requested. Quality warnings and display-window omissions must be preserved in analysis.',
    effect: 'read',
    idempotency: 'intrinsic',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '^/api/v1/', description: 'Local API path without query text.' },
        query: {
          type: 'object',
          description: 'Query parameters. Values are encoded with URLSearchParams.',
          additionalProperties: {
            oneOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', maxItems: 100, items: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] } },
            ],
          },
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    parseInput: parseQuantApiGetInput,
    execute: (input, context) => executePiAgentTool(context.signal, timeoutMs, async (signal) => {
      requestCount += 1;
      if (requestCount > maxRequests) {
        throw new PiAgentToolError(
          'QUANT_API_REQUEST_BUDGET_EXCEEDED',
          `This PI Agent run exceeded its ${maxRequests}-request quant API budget.`,
        );
      }
      const url = buildQuantApiUrl(input.path, input.query);
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      const body = await readBoundedResponse(response, maxResponseBytes, signal);
      const output = compactQuantOutput(body.text, {
        limit: maxOutputChars,
        responseBytes: body.bytes,
        responseByteLimitReached: body.truncated,
        path: url.pathname,
      });
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: 'QUANT_API_HTTP_ERROR',
            message: `Local quant API returned HTTP ${response.status}.`,
            details: {
              status: response.status,
              bodyTruncated: output.truncated,
              ...(output.strategy ? { outputStrategy: output.strategy } : {}),
            },
          },
          content: output.text,
        };
      }

      if (body.truncated) {
        return {
          ok: false,
          error: {
            code: 'QUANT_API_INCOMPLETE_RESPONSE',
            message: 'The response exceeded the byte budget. Retry with a narrower date range or smaller limit.',
          },
          content: output.text,
        };
      }
      let payload: unknown;
      try { payload = JSON.parse(body.text); }
      catch {
        return {
          ok: false,
          error: { code: 'QUANT_API_INVALID_JSON', message: 'The local API did not return valid JSON.' },
        };
      }
      const assessment = assessQuantDataResponse({ path: url.pathname, query: input.query, payload });
      if (assessment.status === 'failed') {
        return {
          ok: false,
          error: {
            code: 'QUANT_API_DATA_INVALID',
            message: `Market data failed consistency checks: ${assessment.issues.map(issue => `${issue.code}@${issue.path}`).join(', ')}`,
            details: { assessment },
          },
        };
      }
      const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
      const canonicalUrl = new URL(url);
      canonicalUrl.searchParams.sort();
      const now = new Date().toISOString();
      const record = payload as Record<string, unknown>;
      const receipt: DataAgentSourceReceipt = {
        sourceId: typeof record.source === 'string' ? record.source : 'local-market-api',
        operationId: `GET ${url.pathname}`,
        observedAt: now,
        fetchedAt: typeof record.fetched_at === 'string' ? record.fetched_at : now,
        fetchedAtOrigin: typeof record.fetched_at === 'string' ? 'source' : 'observed',
        ...(typeof record.as_of === 'string' ? { asOf: record.as_of } : {}),
        querySha256: hash(canonicalUrl.pathname + canonicalUrl.search),
        responseSha256: hash(body.text),
      };
      const assessedOutput = assessment.status === 'warning'
        ? compactQuantOutput(JSON.stringify({ $piAgent: { kind: 'quant_api_data_quality', assessment }, data: payload }), {
            limit: maxOutputChars, responseBytes: body.bytes, responseByteLimitReached: false, path: url.pathname,
          })
        : output;

      return {
        ok: true,
        data: {
          status: response.status,
          bytes: body.bytes,
          truncated: assessedOutput.truncated,
          assessment,
          receipt,
          ...(assessedOutput.strategy ? { outputStrategy: assessedOutput.strategy } : {}),
        },
        content: assessedOutput.text,
      };
    }),
  };
}
