import { readWorkspaceJsonBounded } from '@/lib/data-agent/workspace-read';

const ARTIFACTS = {
  finalData: 'data_file/final/dashboard-data.json',
  sources: 'evidence/sources.json',
  quality: 'evidence/data_quality.json',
  runPlan: '.data-agent/finance-run-plan.json',
} as const;

export interface ReviewEvidenceArtifact {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  value: unknown;
}
export type ReviewEvidence = Record<keyof typeof ARTIFACTS, ReviewEvidenceArtifact>;

function project(value: unknown, limit: number, depth = 0): unknown {
  if (depth > 24) return { reviewOmitted: true };
  if (typeof value === 'string' && value.length > 2048) return { reviewOmitted: true, characters: value.length };
  if (Array.isArray(value)) {
    const retained = value.length <= limit ? value : [...value.slice(0, Math.ceil(limit / 3)), ...value.slice(-(limit - Math.ceil(limit / 3)))];
    return retained.map(item => project(item, limit, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 128)
      .map(([key, item]) => [key, project(item, limit, depth + 1)]));
  }
  return value;
}

export async function loadReviewEvidence(projectPath: string): Promise<ReviewEvidence> {
  const entries = await Promise.all(Object.entries(ARTIFACTS).map(async ([id, artifactPath]) => {
    let artifact: Awaited<ReturnType<typeof readWorkspaceJsonBounded>>;
    try { artifact = await readWorkspaceJsonBounded(projectPath, artifactPath); }
    catch { throw new Error(`Review evidence is missing, unsafe or invalid: ${id}`); }
    if (!artifact.value || typeof artifact.value !== 'object' || Array.isArray(artifact.value)) {
      throw new Error(`Review evidence must be a JSON object: ${id}`);
    }
    let value = artifact.value;
    const original = JSON.stringify(value);
    if (original.length > 24_000) {
      for (const limit of [64, 16, 4, 2]) {
        value = project(artifact.value, limit) as object;
        if (JSON.stringify(value).length <= 24_000) break;
      }
    }
    if (JSON.stringify(value).length > 24_000) throw new Error(`Review evidence cannot fit its context budget: ${id}`);
    return [id, { ...artifact, path: artifactPath, value, truncated: JSON.stringify(value) !== original }] as const;
  }));
  return Object.fromEntries(entries) as ReviewEvidence;
}

/** References address the exact projected JSON the reviewer saw, never a guessed filesystem path. */
export function resolvesReviewEvidence(reference: string, evidence: ReviewEvidence): boolean {
  const match = /^(finalData|sources|quality|runPlan)#(\/[^#]+)$/.exec(reference);
  if (!match || reference.length > 300) return false;
  let value: unknown = evidence[match[1] as keyof ReviewEvidence]?.value;
  for (const part of match[2].slice(1).split('/')) {
    if (/~(?![01])/.test(part)) return false;
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (['__proto__', 'prototype', 'constructor', 'reviewOmitted'].includes(key)) return false;
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
    value = (value as Record<string, unknown>)[key];
  }
  return value !== null && value !== undefined && value !== ''
    && !(typeof value === 'object' && Object.hasOwn(value, 'reviewOmitted'));
}
