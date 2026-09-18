import { truncateToolOutput } from '@/lib/agent/tools/runtime';

const QUANT_WINDOW_VERSION = 1 as const;
const MAX_OMISSION_DETAILS = 24;

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
      $piAgent: metadata,
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
    $piAgent: {
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
export function compactQuantOutput(
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
          $piAgent: {
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
