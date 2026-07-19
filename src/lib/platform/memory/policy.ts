import type { MemoryContext, MemoryProjectionResult } from './types';

const ALLOWED_KEY_PREFIXES = ['analysis.', 'output.', 'research.'] as const;
const FORBIDDEN_KEY_PREFIXES = [
  'authorization.',
  'credential.',
  'order.',
  'security.',
  'trading.execution.',
] as const;
const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,255}$/;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function assertPersonalizationKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (
    !KEY_PATTERN.test(normalized)
    || !ALLOWED_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || FORBIDDEN_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    throw new Error('Unsupported personalization key.');
  }
  return normalized;
}

export function buildPreferenceContext(input: {
  projectId: string;
  scope: 'global' | 'project';
  context?: Record<string, unknown>;
}): MemoryContext {
  const context: MemoryContext = { product: 'quantpilot' };
  if (input.scope === 'project') context.project_id = input.projectId;
  for (const [key, value] of Object.entries(input.context ?? {})) {
    if (key === 'product' || key === 'project_id') continue;
    if (
      /^[a-z][a-z0-9_.-]{0,127}$/.test(key)
      && typeof value === 'string'
      && value.length > 0
      && value.length <= 512
      && Object.keys(context).length < 16
    ) {
      context[key] = value;
    }
  }
  return context;
}

export function isQuantPilotPreference(preference: { key: string; context: MemoryContext }): boolean {
  try {
    assertPersonalizationKey(preference.key);
    return preference.context.product === 'quantpilot';
  } catch {
    return false;
  }
}

export function selectPersonalizationProjection(
  projection: MemoryProjectionResult,
  projectId: string,
): {
  content: string;
  revisionIds: string[];
} {
  const memories: Array<{ context: MemoryContext; key: string; value: string }> = [];
  const revisionIds: string[] = [];

  for (const segment of projection.segments) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(segment.content) as unknown;
    } catch {
      continue;
    }
    const candidate = record(parsed);
    const context = record(candidate?.context);
    const key = typeof candidate?.key === 'string' ? candidate.key : '';
    const value = typeof candidate?.value === 'string' ? candidate.value : '';
    if (!context || !value || value.length > 4_096) continue;
    if (
      ('project_id' in context && typeof context.project_id !== 'string')
      || (typeof context.project_id === 'string' && context.project_id !== projectId)
    ) {
      continue;
    }
    const stringContext = Object.fromEntries(
      Object.entries(context).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    if (!isQuantPilotPreference({ key, context: stringContext })) continue;
    memories.push({ context: stringContext, key: assertPersonalizationKey(key), value });
    revisionIds.push(...segment.sources.map((source) => source.revisionId));
  }

  return {
    content: JSON.stringify({ memories }),
    revisionIds: Array.from(new Set(revisionIds)),
  };
}
