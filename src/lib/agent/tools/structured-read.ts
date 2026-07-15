import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

import type { MoAgentTool } from '@/lib/agent/types';

import { MoAgentToolError, throwIfAborted } from './errors';
import type { MoAgentFileToolOptions } from './filesystem';
import { inputRecord, optionalInteger, requiredString } from './input';
import { MoAgentWorkspacePolicy } from './path-policy';
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executeMoAgentTool,
  truncateToolOutput,
} from './runtime';

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const MAX_JSON_POINTERS = 16;
const MAX_TEXT_ANCHORS = 16;
const MAX_TOTAL_TEXT_MATCHES = 32;
const MAX_PROJECTION_OMISSIONS = 16;
const PREFERRED_JSON_OBJECT_KEYS = [
  'symbol',
  'name',
  'price',
  'close',
  'latest_close',
  'change_percent',
  'periodReturn',
  'return20d',
  'maxDrawdown',
  'volatility20d',
  'date',
  'report_date',
  'latest_report_date',
  'title',
  'summary',
  'primary_view',
  'risk_disclaimer',
  'status',
  'method',
  'rows',
  'data_quality',
] as const;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface StructuredReadRuntime {
  policy(): Promise<MoAgentWorkspacePolicy>;
  timeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
}

interface WorkspaceTextFile {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface MoAgentStructuredReadOptions extends Pick<
  MoAgentFileToolOptions,
  'workspaceRoot' | 'timeoutMs' | 'maxOutputChars' | 'maxFileBytes'
> {}

function createRuntime(options: MoAgentStructuredReadOptions): StructuredReadRuntime {
  let policyPromise: Promise<MoAgentWorkspacePolicy> | undefined;
  return {
    policy: () => policyPromise ??= MoAgentWorkspacePolicy.create({
      workspaceRoot: options.workspaceRoot,
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    maxOutputChars: options.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
}

async function readWorkspaceTextFile(
  runtime: StructuredReadRuntime,
  requestedPath: string,
  signal: AbortSignal,
): Promise<WorkspaceTextFile> {
  throwIfAborted(signal);
  const resolved = await (await runtime.policy()).resolveReadPath(requestedPath);
  const stat = await fs.stat(resolved.canonicalPath);
  if (!stat.isFile()) {
    throw new MoAgentToolError('NOT_A_FILE', `Expected a file: ${resolved.relativePath}.`);
  }
  if (stat.size > runtime.maxFileBytes) {
    throw new MoAgentToolError(
      'FILE_TOO_LARGE',
      `File is ${stat.size} bytes; structured readers allow at most ${runtime.maxFileBytes} bytes.`,
    );
  }
  const buffer = await fs.readFile(resolved.canonicalPath, { signal });
  if (buffer.includes(0)) {
    throw new MoAgentToolError(
      'BINARY_FILE_DENIED',
      `Cannot read binary file as text: ${resolved.relativePath}.`,
    );
  }
  return {
    path: resolved.relativePath,
    content: buffer.toString('utf8'),
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

function parseStringList(
  value: unknown,
  label: string,
  limits: {
    maxItems: number;
    maxChars: number;
    allowEmpty?: boolean;
    allowSingle?: boolean;
  },
): string[] {
  const items = typeof value === 'string' && limits.allowSingle ? [value] : value;
  if (!Array.isArray(items) || items.length === 0 || items.length > limits.maxItems) {
    throw new MoAgentToolError(
      'INVALID_TOOL_INPUT',
      `${label} must be ${limits.allowSingle ? 'a string or ' : ''}an array containing between 1 and ${limits.maxItems} strings.`,
    );
  }
  const output: string[] = [];
  for (const [index, item] of items.entries()) {
    if (
      typeof item !== 'string' ||
      (!limits.allowEmpty && item.trim().length === 0) ||
      item.length > limits.maxChars ||
      /[\r\n\0]/.test(item)
    ) {
      throw new MoAgentToolError(
        'INVALID_TOOL_INPUT',
        `${label}[${index}] must be a${limits.allowEmpty ? '' : ' non-empty'} single-line string of at most ${limits.maxChars} characters.`,
      );
    }
    output.push(item);
  }
  return Array.from(new Set(output));
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function tolerantBoundedInteger(
  record: Record<string, unknown>,
  keys: readonly string[],
  fallback: number,
  limits: { min: number; max: number },
): number {
  const raw = firstDefined(record, keys);
  if (raw === undefined) return fallback;
  const numeric = typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(numeric)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, numeric as number));
}

function tolerantBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
  fallback: boolean,
): boolean {
  const raw = firstDefined(record, keys);
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string' && /^(?:true|false)$/i.test(raw.trim())) {
    return raw.trim().toLowerCase() === 'true';
  }
  return fallback;
}

interface QueryJsonInput {
  path: string;
  pointers: string[];
  maxArrayItems: number;
  maxStringChars: number;
  maxObjectKeys: number;
  maxDepth: number;
}

function parseQueryJsonInput(value: unknown): QueryJsonInput {
  const record = inputRecord(value);
  const pointers = parseStringList(firstDefined(record, ['pointers', 'pointer']), 'pointers', {
    maxItems: MAX_JSON_POINTERS,
    maxChars: 512,
    allowEmpty: true,
    allowSingle: true,
  });
  for (const pointer of pointers) decodeJsonPointer(pointer);
  return {
    path: requiredString(record, 'path', { maxLength: 1_024 }),
    pointers,
    maxArrayItems: optionalInteger(record, 'maxArrayItems', 8, { min: 1, max: 50 }),
    maxStringChars: optionalInteger(record, 'maxStringChars', 600, { min: 32, max: 4_000 }),
    maxObjectKeys: optionalInteger(record, 'maxObjectKeys', 64, { min: 1, max: 200 }),
    maxDepth: optionalInteger(record, 'maxDepth', 8, { min: 1, max: 16 }),
  };
}

function decodeJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new MoAgentToolError(
      'INVALID_TOOL_INPUT',
      `JSON Pointer must be empty for the root or start with '/': ${pointer}`,
    );
  }
  return pointer.slice(1).split('/').map((segment) => {
    if (/~(?:[^01]|$)/.test(segment)) {
      throw new MoAgentToolError(
        'INVALID_TOOL_INPUT',
        `JSON Pointer contains an invalid '~' escape: ${pointer}`,
      );
    }
    return segment.replaceAll('~1', '/').replaceAll('~0', '~');
  });
}

function jsonType(value: JsonValue | undefined): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function jsonShape(value: JsonValue | undefined): Record<string, unknown> {
  if (Array.isArray(value)) {
    const sample = value.find((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
    return {
      originalSize: value.length,
      ...(sample && !Array.isArray(sample) ? { sampleItemKeys: Object.keys(sample).slice(0, 48) } : {}),
    };
  }
  if (value !== null && typeof value === 'object') {
    return { availableKeys: Object.keys(value).slice(0, 64) };
  }
  if (typeof value === 'string') return { originalSize: value.length };
  return {};
}

function compactJsonShape(value: JsonValue | undefined): Record<string, unknown> {
  if (Array.isArray(value) || typeof value === 'string') {
    return { originalSize: value.length };
  }
  return {};
}

function resolvePointer(root: JsonValue, pointer: string): { found: boolean; value?: JsonValue } {
  let current: JsonValue = root;
  for (const segment of decodeJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { found: false };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

interface ProjectionSettings {
  maxArrayItems: number;
  maxStringChars: number;
  maxObjectKeys: number;
  maxDepth: number;
}

interface ProjectionOmission {
  pointer: string;
  kind: 'array_items' | 'object_keys' | 'string_chars' | 'max_depth';
  originalSize: number;
  retainedSize: number;
  strategy?: 'head_and_recent_tail';
}

interface ProjectionState {
  omissionCount: number;
  omissions: ProjectionOmission[];
  maxOmissionDetails: number;
}

function encodePointerSegment(segment: string | number): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function childPointer(parent: string, segment: string | number): string {
  return `${parent}/${encodePointerSegment(segment)}`;
}

function recordOmission(state: ProjectionState, omission: ProjectionOmission): void {
  state.omissionCount += 1;
  if (state.omissions.length < state.maxOmissionDetails) state.omissions.push(omission);
}

function selectedIndexes(length: number, limit: number): number[] {
  if (length <= limit) return Array.from({ length }, (_unused, index) => index);
  if (limit === 1) return [length - 1];
  const headCount = Math.max(1, Math.floor(limit / 3));
  const tailCount = limit - headCount;
  return [
    ...Array.from({ length: headCount }, (_unused, index) => index),
    ...Array.from({ length: tailCount }, (_unused, index) => length - tailCount + index),
  ];
}

function selectedObjectEntries(
  entries: Array<[string, JsonValue]>,
  limit: number,
): Array<[string, JsonValue]> {
  if (entries.length <= limit) return entries;
  const selected = new Set<number>();
  for (const preferredKey of PREFERRED_JSON_OBJECT_KEYS) {
    const index = entries.findIndex(([key]) => key === preferredKey);
    if (index >= 0) selected.add(index);
    if (selected.size >= limit) break;
  }
  if (selected.size < limit) {
    const remaining = entries
      .map((_entry, index) => index)
      .filter((index) => !selected.has(index));
    for (const relativeIndex of selectedIndexes(remaining.length, limit - selected.size)) {
      selected.add(remaining[relativeIndex]);
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => entries[index]);
}

function compactString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.max(1, Math.floor(limit / 3));
  const tail = Math.max(0, limit - head - 1);
  return `${value.slice(0, head)}…${tail ? value.slice(-tail) : ''}`;
}

function projectJson(
  value: JsonValue,
  settings: ProjectionSettings,
  pointer: string,
  depth: number,
  state: ProjectionState,
): JsonValue {
  if (typeof value === 'string') {
    if (value.length <= settings.maxStringChars) return value;
    const projected = compactString(value, settings.maxStringChars);
    recordOmission(state, {
      pointer,
      kind: 'string_chars',
      originalSize: value.length,
      retainedSize: projected.length,
    });
    return projected;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= settings.maxDepth) {
    const size = Array.isArray(value) ? value.length : Object.keys(value).length;
    recordOmission(state, {
      pointer,
      kind: 'max_depth',
      originalSize: size,
      retainedSize: 0,
    });
    return {
      $moagent: 'max_depth_summary',
      valueType: Array.isArray(value) ? 'array' : 'object',
      size,
    };
  }
  if (Array.isArray(value)) {
    const indexes = selectedIndexes(value.length, settings.maxArrayItems);
    if (indexes.length < value.length) {
      recordOmission(state, {
        pointer,
        kind: 'array_items',
        originalSize: value.length,
        retainedSize: indexes.length,
        strategy: 'head_and_recent_tail',
      });
    }
    return indexes.map((index) =>
      projectJson(value[index], settings, childPointer(pointer, index), depth + 1, state)
    );
  }

  const entries = Object.entries(value);
  const retained = selectedObjectEntries(entries, settings.maxObjectKeys);
  if (retained.length < entries.length) {
    recordOmission(state, {
      pointer,
      kind: 'object_keys',
      originalSize: entries.length,
      retainedSize: retained.length,
    });
  }
  return Object.fromEntries(retained.map(([key, child]) => [
    key,
    projectJson(child, settings, childPointer(pointer, key), depth + 1, state),
  ]));
}

interface JsonQueryReport {
  $moagent: {
    kind: 'bounded_json_pointer_query';
    version: 1;
    path: string;
    bytes: number;
    sha256: string;
    selection: 'head_and_recent_tail';
    omissionCount: number;
    omissions: ProjectionOmission[];
    omissionDetailsTruncated: boolean;
  };
  queries: Array<Record<string, unknown>>;
}

function buildJsonQueryReport(
  file: WorkspaceTextFile,
  root: JsonValue,
  pointers: readonly string[],
  settings: ProjectionSettings,
  maxOmissionDetails: number,
  compactShape: boolean,
): JsonQueryReport {
  const state: ProjectionState = {
    omissionCount: 0,
    omissions: [],
    maxOmissionDetails,
  };
  const queries = pointers.map((pointer) => {
    const resolved = resolvePointer(root, pointer);
    if (!resolved.found || resolved.value === undefined) {
      return { pointer, found: false, valueType: null };
    }
    return {
      pointer,
      found: true,
      valueType: jsonType(resolved.value),
      ...(compactShape ? compactJsonShape(resolved.value) : jsonShape(resolved.value)),
      value: projectJson(resolved.value, settings, pointer, 0, state),
    };
  });
  return {
    $moagent: {
      kind: 'bounded_json_pointer_query',
      version: 1,
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      selection: 'head_and_recent_tail',
      omissionCount: state.omissionCount,
      omissions: state.omissions,
      omissionDetailsTruncated: state.omissionCount > state.omissions.length,
    },
    queries,
  };
}

function boundedJsonQueryReport(
  file: WorkspaceTextFile,
  root: JsonValue,
  input: QueryJsonInput,
  maxOutputChars: number,
): { content: string; truncated: boolean } {
  const settings: ProjectionSettings[] = [];
  let current = {
    maxArrayItems: input.maxArrayItems,
    maxStringChars: input.maxStringChars,
    maxObjectKeys: input.maxObjectKeys,
    maxDepth: input.maxDepth,
  };
  for (let pass = 0; pass < 10; pass += 1) {
    settings.push(current);
    current = {
      maxArrayItems: Math.max(1, Math.floor(current.maxArrayItems / 2)),
      maxStringChars: Math.max(24, Math.floor(current.maxStringChars / 2)),
      maxObjectKeys: Math.max(4, Math.floor(current.maxObjectKeys / 2)),
      maxDepth: Math.max(1, current.maxDepth - 1),
    };
  }
  const detailedOmissionLimit = Math.min(
    MAX_PROJECTION_OMISSIONS,
    Math.max(2, Math.floor(24 / input.pointers.length)),
  );
  for (const candidateSettings of settings) {
    for (const projection of [
      { omissionLimit: detailedOmissionLimit, compactShape: false },
      { omissionLimit: 0, compactShape: false },
      { omissionLimit: 0, compactShape: true },
    ]) {
      const report = buildJsonQueryReport(
        file,
        root,
        input.pointers,
        candidateSettings,
        projection.omissionLimit,
        projection.compactShape,
      );
      const content = JSON.stringify(report, null, 2);
      if (content.length <= maxOutputChars) {
        const reduced = candidateSettings.maxArrayItems < input.maxArrayItems ||
          candidateSettings.maxStringChars < input.maxStringChars ||
          candidateSettings.maxObjectKeys < input.maxObjectKeys ||
          candidateSettings.maxDepth < input.maxDepth;
        return { content, truncated: reduced || report.$moagent.omissionCount > 0 };
      }
    }
  }

  const minimal = JSON.stringify({
    $moagent: {
      kind: 'bounded_json_pointer_query',
      version: 1,
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      valuesOmittedForOutputBudget: true,
      retry: {
        action: 'split_pointer_batch',
        suggestedPointersPerCall: '6-8',
        message: 'Retry with exact nested or leaf pointers; split into at most two related batches only if necessary.',
      },
    },
    queries: input.pointers.map((pointer) => {
      const resolved = resolvePointer(root, pointer);
      return {
        pointer,
        found: resolved.found,
        valueType: jsonType(resolved.value),
        ...jsonShape(resolved.value),
      };
    }),
  }, null, 2);
  if (minimal.length > maxOutputChars) {
    throw new MoAgentToolError(
      'TOOL_OUTPUT_TOO_LARGE',
      'query_json metadata exceeds the configured tool output budget; request fewer pointers.',
    );
  }
  return { content: minimal, truncated: true };
}

export function createQueryJsonTool(
  options: MoAgentStructuredReadOptions,
): MoAgentTool<QueryJsonInput> {
  const runtime = createRuntime(options);
  return {
    name: 'query_json',
    description: 'Batch-query all required RFC 6901 JSON Pointers from one workspace JSON file in a single call (maximum 16); do not call once per pointer. For a dashboard, request quote, kline/technical summaries, financials, events, metrics, and conclusion together. Use exact nested paths where possible. Output is automatically bounded; large arrays keep early and recent samples with explicit omission metadata.',
    effect: 'read',
    idempotency: 'intrinsic',
    observationCache: 'workspace_generation',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative JSON file.' },
        pointers: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_JSON_POINTERS,
          items: { type: 'string' },
          description: 'All needed paths in one array, for example ["/quote","/kline/bars","/technicalIndicators/summary","/financials/reports","/announcements/announcements","/computedMetrics","/conclusion"]. Use an empty string only to discover root keys.',
        },
      },
      required: ['path', 'pointers'],
      additionalProperties: false,
    },
    parseInput: parseQueryJsonInput,
    execute: (input, context) => executeMoAgentTool(
      context.signal,
      runtime.timeoutMs,
      async (signal) => {
        const file = await readWorkspaceTextFile(runtime, input.path, signal);
        let parsed: unknown;
        try {
          parsed = JSON.parse(file.content) as unknown;
        } catch {
          throw new MoAgentToolError(
            'INVALID_JSON_FILE',
            `Cannot query invalid JSON: ${file.path}.`,
          );
        }
        if (parsed === undefined) {
          throw new MoAgentToolError('INVALID_JSON_FILE', `JSON has no root value: ${file.path}.`);
        }
        const rendered = boundedJsonQueryReport(
          file,
          parsed as JsonValue,
          input,
          runtime.maxOutputChars,
        );
        return {
          ok: true,
          data: {
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
            queryCount: input.pointers.length,
            truncated: rendered.truncated,
          },
          content: rendered.content,
        };
      },
    ),
  };
}

interface QueryTextFileInput {
  path: string;
  anchors: string[];
  caseSensitive: boolean;
  beforeLines: number;
  afterLines: number;
  maxMatchesPerAnchor: number;
}

function parseQueryTextFileInput(value: unknown): QueryTextFileInput {
  const record = inputRecord(value);
  return {
    path: requiredString(record, 'path', { maxLength: 1_024 }),
    anchors: parseStringList(firstDefined(record, ['anchors', 'queries', 'query']), 'anchors', {
      maxItems: MAX_TEXT_ANCHORS,
      maxChars: 200,
      allowSingle: true,
    }),
    caseSensitive: tolerantBoolean(record, ['caseSensitive'], true),
    beforeLines: tolerantBoundedInteger(record, ['beforeLines'], 3, { min: 0, max: 50 }),
    afterLines: tolerantBoundedInteger(record, ['afterLines'], 48, { min: 0, max: 200 }),
    maxMatchesPerAnchor: tolerantBoundedInteger(
      record,
      ['maxMatchesPerAnchor', 'maxMatchesPerQuery'],
      2,
      { min: 1, max: 10 },
    ),
  };
}

interface TextWindow {
  start: number;
  end: number;
  matches: Array<{ anchor: string; line: number }>;
}

function mergeTextWindows(windows: TextWindow[]): TextWindow[] {
  const sorted = [...windows].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextWindow[] = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (!previous || window.start > previous.end + 1) {
      merged.push({ ...window, matches: [...window.matches] });
      continue;
    }
    previous.end = Math.max(previous.end, window.end);
    previous.matches.push(...window.matches);
  }
  return merged;
}

function buildTextWindows(
  matches: Array<{ anchor: string; line: number }>,
  totalLines: number,
  beforeLines: number,
  afterLines: number,
  scale: number,
): TextWindow[] {
  const scaledBefore = Math.floor(beforeLines * scale);
  const scaledAfter = Math.floor(afterLines * scale);
  return mergeTextWindows(matches.map((match) => ({
    start: Math.max(1, match.line - scaledBefore),
    end: Math.min(totalLines, match.line + scaledAfter),
    matches: [match],
  })));
}

function renderTextWindows(
  file: WorkspaceTextFile,
  lines: readonly string[],
  windows: readonly TextWindow[],
): string[] {
  return windows.map((window, index) => {
    const header = `[window ${index + 1}: ${file.path}:${window.start}-${window.end}; ${window.matches.map((match) => `${match.anchor}@${match.line}`).join(', ')}]`;
    const body = lines
      .slice(window.start - 1, window.end)
      .map((line, offset) => `${window.start + offset}: ${line}`)
      .join('\n');
    return `${header}\n${body}`;
  });
}

function boundedTextWindows(
  file: WorkspaceTextFile,
  lines: readonly string[],
  matches: Array<{ anchor: string; line: number }>,
  input: QueryTextFileInput,
  maxOutputChars: number,
): {
  content: string;
  truncated: boolean;
  contextScale: number;
  windows: TextWindow[];
} {
  if (matches.length === 0) {
    return { content: 'No matches.', truncated: false, contextScale: 1, windows: [] };
  }
  for (const scale of [1, 0.75, 0.5, 0.33, 0.2, 0.1, 0]) {
    const windows = buildTextWindows(
      matches,
      lines.length,
      input.beforeLines,
      input.afterLines,
      scale,
    );
    const content = renderTextWindows(file, lines, windows).join('\n\n');
    if (content.length <= maxOutputChars) {
      return { content, truncated: scale < 1, contextScale: scale, windows };
    }
    if (scale !== 0) continue;

    const renderedWindows = renderTextWindows(file, lines, windows);
    const separatorChars = Math.max(0, renderedWindows.length - 1) * 2;
    const perWindowLimit = Math.floor(
      Math.max(0, maxOutputChars - separatorChars) / renderedWindows.length,
    );
    const fair = perWindowLimit > 0
      ? renderedWindows
          .map((window) => truncateToolOutput(window, perWindowLimit).text)
          .join('\n\n')
      : '';
    const bounded = truncateToolOutput(fair, maxOutputChars);
    return {
      content: bounded.text,
      truncated: true,
      contextScale: 0,
      windows,
    };
  }
  throw new MoAgentToolError('TEXT_WINDOW_PROJECTION_FAILED', 'Unable to bound text windows.');
}

export function createQueryTextFileTool(
  options: MoAgentStructuredReadOptions,
): MoAgentTool<QueryTextFileInput> {
  const runtime = createRuntime(options);
  return {
    name: 'query_text_file',
    description: 'Batch-read bounded source windows around all needed literal anchors in one call. Put short single-line component, function, selector, or exact-code anchors in the anchors array; do not call once per anchor. Context is automatically reduced fairly so every matched anchor remains represented within the output budget.',
    effect: 'read',
    idempotency: 'intrinsic',
    observationCache: 'workspace_generation',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative non-JSON text/source file.' },
        anchors: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TEXT_ANCHORS,
          items: { type: 'string' },
          description: 'All short literal anchors for this file in one array, for example ["function TrendChart", "function FinancialPanel", "export default async function Home"].',
        },
      },
      required: ['path', 'anchors'],
      additionalProperties: false,
    },
    parseInput: parseQueryTextFileInput,
    execute: (input, context) => executeMoAgentTool(
      context.signal,
      runtime.timeoutMs,
      async (signal) => {
        if (/\.json$/i.test(input.path)) {
          throw new MoAgentToolError(
            'STRUCTURED_JSON_QUERY_REQUIRED',
            'Use query_json with JSON Pointers instead of query_text_file for JSON files.',
          );
        }
        const file = await readWorkspaceTextFile(runtime, input.path, signal);
        const lines = file.content.split(/\r?\n/);
        const discovered = input.anchors.map((anchor) => {
          const needle = input.caseSensitive ? anchor : anchor.toLocaleLowerCase();
          const linesForAnchor: number[] = [];
          for (let index = 0; index < lines.length; index += 1) {
            const haystack = input.caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
            if (!haystack.includes(needle)) continue;
            linesForAnchor.push(index + 1);
            if (linesForAnchor.length >= input.maxMatchesPerAnchor) break;
          }
          return { anchor, lines: linesForAnchor };
        });
        const selectedMatches: Array<{ anchor: string; line: number }> = [];
        for (let matchIndex = 0; selectedMatches.length < MAX_TOTAL_TEXT_MATCHES; matchIndex += 1) {
          let added = false;
          for (const item of discovered) {
            const line = item.lines[matchIndex];
            if (line === undefined) continue;
            selectedMatches.push({ anchor: item.anchor, line });
            added = true;
            if (selectedMatches.length >= MAX_TOTAL_TEXT_MATCHES) break;
          }
          if (!added) break;
        }
        const rendered = boundedTextWindows(
          file,
          lines,
          selectedMatches,
          input,
          runtime.maxOutputChars,
        );
        const selectedByAnchor = new Map<string, number[]>();
        for (const match of selectedMatches) {
          const selected = selectedByAnchor.get(match.anchor) ?? [];
          selected.push(match.line);
          selectedByAnchor.set(match.anchor, selected);
        }
        const totalDiscoveredMatches = discovered.reduce((sum, item) => sum + item.lines.length, 0);
        return {
          ok: true,
          data: {
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
            totalLines: lines.length,
            anchorMatches: discovered.map((item) => ({
              anchor: item.anchor,
              lines: selectedByAnchor.get(item.anchor) ?? [],
              omittedMatches: item.lines.length - (selectedByAnchor.get(item.anchor)?.length ?? 0),
            })),
            selectedMatchCount: selectedMatches.length,
            matchesTruncated: totalDiscoveredMatches > selectedMatches.length,
            windowCount: rendered.windows.length,
            contextScale: rendered.contextScale,
            truncated: rendered.truncated,
          },
          content: rendered.content,
        };
      },
    ),
  };
}
