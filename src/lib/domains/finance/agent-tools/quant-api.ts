import type { MoAgentTool } from '@/lib/agent/types';
import { MoAgentToolError, throwIfAborted } from '@/lib/agent/tools/errors';
import { inputRecord, requiredString } from '@/lib/agent/tools/input';
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executeMoAgentTool,
  truncateToolOutput,
} from '@/lib/agent/tools/runtime';

const QUANT_API_ORIGIN = 'http://127.0.0.1:8000';
const QUANT_API_PREFIX = '/api/v1/';
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_REQUESTS = 32;
const MAX_URL_CHARS = 8_192;
const QUANT_WINDOW_VERSION = 1 as const;
const MAX_OMISSION_DETAILS = 24;
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
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface QuantJsonOmission {
  path: string;
  kind: 'array' | 'string';
  originalSize: number;
  retainedSize: number;
}

interface QuantJsonProjectionState {
  omissionCount: number;
  omissions: QuantJsonOmission[];
}

interface QuantOutput {
  text: string;
  truncated: boolean;
  strategy?: 'json_window' | 'bounded_preview' | 'response_byte_limit';
}

export interface QuantApiGetInput {
  path: string;
  query: Record<string, QueryValue>;
}

export interface MoAgentQuantApiToolOptions {
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
  throw new MoAgentToolError(
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
    throw new MoAgentToolError('INVALID_TOOL_INPUT', 'query accepts at most 100 keys.');
  }
  for (const [key, queryValue] of entries) {
    if (!key || key.length > 200 || /[\r\n\0]/.test(key)) {
      throw new MoAgentToolError('INVALID_TOOL_INPUT', 'Query keys must be 1-200 printable characters.');
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
    throw new MoAgentToolError(
      'QUANT_API_PATH_DENIED',
      'quant_api_get only accepts paths beginning with /api/v1/.',
    );
  }
  if (apiPath.includes('\\') || apiPath.includes('?') || apiPath.includes('#') || /[\r\n\0]/.test(apiPath)) {
    throw new MoAgentToolError('QUANT_API_PATH_DENIED', 'The API path must not contain query text, fragments, backslashes, or control characters.');
  }
  const rawSegments = apiPath.split('/');
  for (const rawSegment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new MoAgentToolError('QUANT_API_PATH_DENIED', 'The API path contains malformed percent encoding.');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new MoAgentToolError('QUANT_API_PATH_DENIED', 'API path traversal and encoded separators are denied.');
    }
  }

  const url = new URL(apiPath, QUANT_API_ORIGIN);
  if (url.origin !== QUANT_API_ORIGIN || !url.pathname.startsWith(QUANT_API_PREFIX)) {
    throw new MoAgentToolError('QUANT_API_PATH_DENIED', 'The API request must remain on the local /api/v1/ endpoint.');
  }
  if (!ALLOWED_QUANT_API_PATHS.some((pattern) => pattern.test(url.pathname))) {
    throw new MoAgentToolError(
      'QUANT_API_ENDPOINT_DENIED',
      'The requested local API endpoint is not in the MoAgent read-only quant allowlist.',
    );
  }
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(key, String(item));
  }
  if (url.toString().length > MAX_URL_CHARS) {
    throw new MoAgentToolError('QUANT_API_URL_TOO_LONG', `Quant API URLs cannot exceed ${MAX_URL_CHARS} characters.`);
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
        await reader.cancel('MoAgent response byte limit reached.').catch(() => undefined);
        break;
      }
      if (result.value.byteLength > remaining) {
        chunks.push(result.value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        await reader.cancel('MoAgent response byte limit reached.').catch(() => undefined);
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

function jsonPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function recordOmission(
  state: QuantJsonProjectionState,
  omission: QuantJsonOmission,
): void {
  state.omissionCount += 1;
  if (state.omissions.length < MAX_OMISSION_DETAILS) state.omissions.push(omission);
}

function selectedArrayIndexes(length: number, limit: number): number[] {
  if (length <= limit) return Array.from({ length }, (_unused, index) => index);
  if (limit <= 1) return limit === 1 ? [length - 1] : [];
  const headCount = Math.max(1, Math.floor(limit / 3));
  const tailCount = limit - headCount;
  return [
    ...Array.from({ length: headCount }, (_unused, index) => index),
    ...Array.from({ length: tailCount }, (_unused, index) => length - tailCount + index),
  ];
}

function compactString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.max(1, Math.floor(limit / 3));
  const tail = Math.max(0, limit - head);
  return `${value.slice(0, head)}${tail ? value.slice(-tail) : ''}`;
}

function projectJsonValue(
  value: JsonValue,
  options: { arrayItems: number; stringChars: number },
  path: string,
  state: QuantJsonProjectionState,
): JsonValue {
  if (typeof value === 'string') {
    if (value.length <= options.stringChars) return value;
    const projected = compactString(value, options.stringChars);
    recordOmission(state, {
      path,
      kind: 'string',
      originalSize: value.length,
      retainedSize: projected.length,
    });
    return projected;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const indexes = selectedArrayIndexes(value.length, options.arrayItems);
    if (indexes.length !== value.length) {
      recordOmission(state, {
        path,
        kind: 'array',
        originalSize: value.length,
        retainedSize: indexes.length,
      });
    }
    return indexes.map((index) =>
      projectJsonValue(value[index], options, jsonPath(path, index), state)
    );
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      projectJsonValue(child, options, jsonPath(path, key), state),
    ])
  );
}

function serializeBoundedPreview(
  value: string,
  limit: number,
  metadata: Record<string, unknown>,
): string {
  let low = 0;
  let high = Math.min(value.length, limit);
  let fitted = '';
  while (low <= high) {
    const previewChars = Math.floor((low + high) / 2);
    const preview = compactString(value, previewChars);
    const candidate = JSON.stringify({
      $moagent: metadata,
      preview,
    });
    if (candidate.length <= limit) {
      fitted = candidate;
      low = previewChars + 1;
    } else {
      high = previewChars - 1;
    }
  }
  if (fitted) return fitted;

  const minimal = JSON.stringify({
    $moagent: {
      kind: 'quant_api_result_window',
      version: QUANT_WINDOW_VERSION,
      truncated: true,
    },
  });
  return truncateToolOutput(minimal, limit).text;
}

/**
 * Keep large market-data responses valid JSON. Time-series arrays retain an
 * early sample and a larger recent tail, while top-level metadata, summaries,
 * data-quality fields, and every object field remain available to the model.
 */
function compactQuantOutput(
  value: string,
  options: {
    limit: number;
    responseBytes: number;
    responseByteLimitReached: boolean;
    path: string;
  },
): QuantOutput {
  if (!options.responseByteLimitReached && value.length <= options.limit) {
    return { text: value, truncated: false };
  }

  const baseMetadata = {
    kind: 'quant_api_result_window',
    version: QUANT_WINDOW_VERSION,
    truncated: true,
    sourcePath: options.path,
    responseBytesRead: options.responseBytes,
    responseByteLimitReached: options.responseByteLimitReached,
  } as const;

  if (!options.responseByteLimitReached) {
    try {
      const parsed = JSON.parse(value) as JsonValue;
      const projections = [
        { arrayItems: 128, stringChars: 4_096 },
        { arrayItems: 64, stringChars: 2_048 },
        { arrayItems: 32, stringChars: 1_024 },
        { arrayItems: 16, stringChars: 512 },
        { arrayItems: 8, stringChars: 256 },
        { arrayItems: 4, stringChars: 128 },
        { arrayItems: 2, stringChars: 96 },
        { arrayItems: 1, stringChars: 64 },
      ] as const;

      for (const projection of projections) {
        const state: QuantJsonProjectionState = { omissionCount: 0, omissions: [] };
        const data = projectJsonValue(parsed, projection, '$', state);
        const candidate = JSON.stringify({
          $moagent: {
            ...baseMetadata,
            strategy: 'head_and_recent_tail',
            originalCharacters: value.length,
            omissionCount: state.omissionCount,
            omissions: state.omissions,
            omissionDetailsTruncated: state.omissionCount > state.omissions.length,
          },
          data,
        });
        if (candidate.length <= options.limit) {
          return { text: candidate, truncated: true, strategy: 'json_window' };
        }
      }
    } catch {
      // The API advertises JSON, but a bounded valid preview is safer than
      // leaking an oversized or malformed body into the model context.
    }
  }

  const strategy = options.responseByteLimitReached
    ? 'response_byte_limit'
    : 'bounded_preview';
  return {
    text: serializeBoundedPreview(value, options.limit, {
      ...baseMetadata,
      strategy,
      originalCharactersRead: value.length,
      retryHint: options.responseByteLimitReached
        ? 'Retry with a narrower date range, smaller limit, or smaller page_size.'
        : 'The response was not valid compactable JSON; use a narrower query if more detail is required.',
    }),
    truncated: true,
    strategy,
  };
}

export function createQuantApiGetTool(options: MoAgentQuantApiToolOptions = {}): MoAgentTool<QuantApiGetInput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let requestCount = 0;
  return {
    name: 'quant_api_get',
    description: 'GET market and quant data from the fixed local http://127.0.0.1:8000/api/v1/ service. No other host or method is available.',
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
    execute: (input, context) => executeMoAgentTool(context.signal, timeoutMs, async (signal) => {
      requestCount += 1;
      if (requestCount > maxRequests) {
        throw new MoAgentToolError(
          'QUANT_API_REQUEST_BUDGET_EXCEEDED',
          `This MoAgent run exceeded its ${maxRequests}-request quant API budget.`,
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

      return {
        ok: true,
        data: {
          status: response.status,
          bytes: body.bytes,
          truncated: output.truncated,
          ...(output.strategy ? { outputStrategy: output.strategy } : {}),
        },
        content: output.text,
      };
    }),
  };
}
