import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashMoAgentProvenance } from '@/lib/services/moagent-provenance';
import { compileMoAgentMissionSpec } from './compiler';
import { createTestMissionDefinition } from './test-support';
import {
  MoAgentEvidenceVerificationError,
  verifyMoAgentMissionEvidence,
} from './evidence-verifier';
import type { MoAgentMissionSpec } from './types';

const CREATED_AT = '2026-07-15T04:00:00.000Z';
const READY_AT = new Date('2026-07-15T04:05:00.000Z');
const PREVIEW = { url: 'http://127.0.0.1:4134', port: 4134 };
const temporaryDirectories: string[] = [];

type ValidationCheck = {
  id: string;
  name: string;
  status: 'passed' | 'failed' | 'warning';
  summary: string;
};

function missionSpec(): MoAgentMissionSpec {
  return compileMoAgentMissionSpec({
    projectId: 'project-evidence',
    requestId: 'request-evidence',
    objective: '生成通过独立证据验收的看板',
    capabilityId: 'technical_analysis',
    runPlanId: 'request-evidence',
    composition: {
      profileId: 'test.data-agent',
      profileVersion: '1.0.0',
      domainPacks: [{ id: 'test.data', version: '1.0.0' }],
      deliveryPackId: 'workspace.next-dashboard',
      deliveryPackVersion: '1.0.0',
      compositionSha256: `sha256:${'a'.repeat(64)}`,
    },
    entities: [{ entityType: 'test.entity', canonicalId: '600519' }],
    maxRepairAttempts: 2,
    definition: createTestMissionDefinition({ maxRepairAttempts: 2 }),
    createdAt: CREATED_AT,
  });
}

function passedChecks(spec: MoAgentMissionSpec): ValidationCheck[] {
  return spec.requiredValidationCheckIds.map((id) => ({
    id,
    name: id,
    status: 'passed',
    summary: `${id} passed`,
  }));
}

function validationReport(
  spec: MoAgentMissionSpec,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    schemaVersion: 1,
    runId: spec.requestId,
    projectId: spec.projectId,
    status: 'passed',
    passed: true,
    checks: passedChecks(spec),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

async function writeFile(root: string, relativePath: string, value: unknown) {
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
}

async function createWorkspace(input: {
  spec?: MoAgentMissionSpec;
  report?: Record<string, unknown>;
  omitted?: readonly string[];
} = {}) {
  const spec = input.spec ?? missionSpec();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-evidence-'));
  temporaryDirectories.push(root);
  const omitted = new Set(input.omitted ?? []);
  for (const artifact of spec.artifacts) {
    if (!artifact.required || artifact.role === 'control' || omitted.has(artifact.path)) {
      continue;
    }
    if (artifact.path === spec.validationReportPath) {
      await writeFile(root, artifact.path, input.report ?? validationReport(spec));
    } else {
      await writeFile(root, artifact.path, {
        schemaVersion: 1,
        artifact: artifact.path,
      });
    }
  }
  return { root, spec };
}

function specHash(spec: MoAgentMissionSpec) {
  return `sha256:${hashMoAgentProvenance(spec)}`;
}

function readyFetch() {
  return vi.fn(async () => new Response('<!doctype html><main>ready</main>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
}

function sha256FileContent(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function verify(input: {
  root: string;
  spec: MoAgentMissionSpec;
  preview?: { url: string; port: number };
  fetchImpl?: typeof fetch;
  missionSpecSha256?: string;
}) {
  return verifyMoAgentMissionEvidence({
    missionId: 'mission-evidence',
    generationId: 'generation-evidence',
    candidateVersion: 1,
    missionSpec: input.spec,
    missionSpecSha256: input.missionSpecSha256 ?? specHash(input.spec),
    workspaceRoot: input.root,
    preview: input.preview ?? PREVIEW,
    fetchImpl: input.fetchImpl ?? (readyFetch() as unknown as typeof fetch),
    now: () => READY_AT,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })));
});

describe('MoAgent EvidenceVerifier', () => {
  it('accepts a complete current-run receipt and excludes mutable control artifacts', async () => {
    const fixture = await createWorkspace();

    const first = await verify(fixture);
    const second = await verify(fixture);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      verdict: 'accepted',
      reasonCodes: [],
      failedCheckIds: [],
      candidateVersion: 1,
    });
    expect(first.subjectHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.receiptHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.payload.preview).toMatchObject({
      httpStatus: 200,
      readyAt: READY_AT.toISOString(),
    });
    expect(first.payload.artifacts.issues).toEqual([]);
    expect(first.payload.artifacts.items.every((item) => item.role === 'subject')).toBe(true);
    expect(first.payload.artifacts.evidenceItems.every((item) => item.role === 'evidence')).toBe(true);
    expect([
      ...first.payload.artifacts.items,
      ...first.payload.artifacts.evidenceItems,
    ].map((item) => item.path)).not.toContain('.data-agent/state.json');
  });

  it('accepts when every optional source surface is absent', async () => {
    const fixture = await createWorkspace();

    const decision = await verify(fixture);

    expect(decision.verdict).toBe('accepted');
    expect(decision.payload.artifacts.items.some((item) => item.path.includes('/**'))).toBe(false);
  });

  it('hashes existing source, root-config, and evidence surfaces with subject-first deduplication', async () => {
    const fixture = await createWorkspace();
    await writeFile(fixture.root, 'components/MetricPanel.tsx', 'export const value = 1;\n');
    await writeFile(fixture.root, 'next.config.mjs', 'export default {};\n');
    await writeFile(fixture.root, 'evidence/runtime.json', { source: 'preview' });
    await writeFile(
      fixture.root,
      'components/node_modules/ignored.js',
      'throw new Error("must not be fingerprinted");\n',
    );

    const decision = await verify(fixture);
    const subjects = decision.payload.artifacts.items.map((item) => item.path);
    const evidence = decision.payload.artifacts.evidenceItems.map((item) => item.path);

    expect(decision.verdict).toBe('accepted');
    expect(subjects).toEqual(expect.arrayContaining([
      'components/MetricPanel.tsx',
      'next.config.mjs',
      'evidence/sources.json',
    ]));
    expect(evidence).toContain('evidence/runtime.json');
    expect(evidence).not.toContain('evidence/sources.json');
    expect([...subjects, ...evidence]).not.toContain('components/node_modules/ignored.js');
  });

  it('rejects a validation report missing a required check without probing preview', async () => {
    const spec = missionSpec();
    const checks = passedChecks(spec).filter((check) => check.id !== 'visual_presentation');
    const fixture = await createWorkspace({
      spec,
      report: validationReport(spec, { checks }),
    });
    const fetchImpl = readyFetch();

    const decision = await verify({
      ...fixture,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toMatchObject({
      verdict: 'rejected',
      reasonCodes: ['REQUIRED_VALIDATION_CHECK_MISSING'],
      failedCheckIds: ['visual_presentation'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects duplicate validation check identities', async () => {
    const spec = missionSpec();
    const checks = passedChecks(spec);
    checks.push({ ...checks[0] });
    const fixture = await createWorkspace({
      spec,
      report: validationReport(spec, { checks }),
    });

    const decision = await verify(fixture);

    expect(decision).toMatchObject({
      verdict: 'rejected',
      reasonCodes: ['VALIDATION_CHECK_DUPLICATED'],
      failedCheckIds: ['next_build'],
    });
  });

  it('returns repair_required for a failed required validation check', async () => {
    const spec = missionSpec();
    const checks = passedChecks(spec).map((check) =>
      check.id === 'visual_presentation'
        ? { ...check, status: 'failed' as const, summary: 'mobile overflow' }
        : check);
    const fixture = await createWorkspace({
      spec,
      report: validationReport(spec, { status: 'failed', passed: false, checks }),
    });

    const decision = await verify(fixture);

    expect(decision).toMatchObject({
      verdict: 'repair_required',
      reasonCodes: ['REQUIRED_VALIDATION_CHECK_FAILED'],
      failedCheckIds: ['visual_presentation'],
    });
  });

  it('accepts an allowed evidence quality warning when the report is otherwise passed', async () => {
    const spec = missionSpec();
    const checks = passedChecks(spec).map((check) =>
      check.id === 'evidence_files'
        ? { ...check, status: 'warning' as const, summary: 'limitations are disclosed' }
        : check);
    const fixture = await createWorkspace({
      spec,
      report: validationReport(spec, { checks }),
    });

    const decision = await verify(fixture);

    expect(spec.allowedValidationWarnings).toEqual(['evidence_files']);
    expect(decision.verdict).toBe('accepted');
  });

  it('persists a repair decision when required derived evidence is not generated', async () => {
    const spec = missionSpec();
    const checks = passedChecks(spec).map((check) =>
      check.id === 'visual_presentation'
        ? { ...check, status: 'failed' as const, summary: 'visual validation failed' }
        : check);
    const fixture = await createWorkspace({
      spec,
      report: validationReport(spec, { status: 'failed', passed: false, checks }),
      omitted: [
        '.data-agent/visual-validation.json',
        '.data-agent/artifact-contracts.json',
      ],
    });

    const decision = await verify(fixture);

    expect(decision.verdict).toBe('repair_required');
    expect(decision.reasonCodes).toEqual([
      'REQUIRED_VALIDATION_CHECK_FAILED',
      'REQUIRED_DERIVED_EVIDENCE_UNAVAILABLE',
    ]);
    expect(decision.payload.artifacts.issues).toEqual([
      {
        path: '.data-agent/artifact-contracts.json',
        role: 'evidence',
        code: 'REQUIRED_ARTIFACT_MISSING',
      },
      {
        path: '.data-agent/visual-validation.json',
        role: 'evidence',
        code: 'REQUIRED_ARTIFACT_MISSING',
      },
    ]);
  });

  it('returns a repair receipt instead of throwing when a required subject is missing', async () => {
    const spec = missionSpec();
    const checks = passedChecks(spec).map((check) =>
      check.id === 'next_build'
        ? { ...check, status: 'failed' as const, summary: 'page missing' }
        : check);
    const fixture = await createWorkspace({
      spec,
      report: validationReport(spec, { status: 'failed', passed: false, checks }),
      omitted: ['app/page.tsx'],
    });

    const decision = await verify(fixture);

    expect(decision.verdict).toBe('repair_required');
    expect(decision.reasonCodes).toEqual([
      'REQUIRED_VALIDATION_CHECK_FAILED',
      'REQUIRED_SUBJECT_ARTIFACT_UNAVAILABLE',
    ]);
    expect(decision.payload.artifacts.issues).toContainEqual({
      path: 'app/page.tsx',
      role: 'subject',
      code: 'REQUIRED_ARTIFACT_MISSING',
    });
  });

  it('marks evidence stale if a subject changes while the persistent preview is probed', async () => {
    const fixture = await createWorkspace();
    const fetchImpl = vi.fn(async () => {
      await writeFile(fixture.root, 'app/page.tsx', 'export default function Changed() {}\n');
      return new Response('<!doctype html><main>ready</main>', { status: 200 });
    });

    const decision = await verify({
      ...fixture,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toMatchObject({
      verdict: 'stale',
      reasonCodes: ['SUBJECT_MANIFEST_CHANGED_DURING_VERIFICATION'],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('marks evidence stale if an optional component changes during preview verification', async () => {
    const fixture = await createWorkspace();
    await writeFile(fixture.root, 'components/MetricPanel.tsx', 'export const value = 1;\n');
    const fetchImpl = vi.fn(async () => {
      await writeFile(fixture.root, 'components/MetricPanel.tsx', 'export const value = 2;\n');
      return new Response('<!doctype html><main>ready</main>', { status: 200 });
    });

    const decision = await verify({
      ...fixture,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toMatchObject({
      verdict: 'stale',
      reasonCodes: ['SUBJECT_MANIFEST_CHANGED_DURING_VERIFICATION'],
    });
    expect(decision.payload.artifacts.items).toContainEqual(expect.objectContaining({
      path: 'components/MetricPanel.tsx',
      role: 'subject',
    }));
  });

  it('marks the receipt stale and uses the second validation report if it changes', async () => {
    const fixture = await createWorkspace();
    const changedReport = validationReport(fixture.spec, {
      updatedAt: '2026-07-15T04:04:59.000Z',
    });
    const changedContent = `${JSON.stringify(changedReport, null, 2)}\n`;
    const fetchImpl = vi.fn(async () => {
      await writeFile(fixture.root, fixture.spec.validationReportPath, changedReport);
      return new Response('<!doctype html><main>ready</main>', { status: 200 });
    });

    const decision = await verify({
      ...fixture,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toMatchObject({
      verdict: 'stale',
      reasonCodes: ['VALIDATION_REPORT_CHANGED_DURING_VERIFICATION'],
    });
    expect(decision.payload.validation.reportSha256).toBe(sha256FileContent(changedContent));
  });

  it('fails closed when an acceptance-surface symlink escapes the workspace', async () => {
    const fixture = await createWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-evidence-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(outside, 'secret.ts', 'export const secret = true;\n');
    await fs.mkdir(path.join(fixture.root, 'components'), { recursive: true });
    await fs.symlink(
      path.join(outside, 'secret.ts'),
      path.join(fixture.root, 'components', 'escaped.ts'),
    );

    await expect(verify(fixture)).rejects.toEqual(
      expect.objectContaining<Partial<MoAgentEvidenceVerificationError>>({
        code: 'ARTIFACT_SYMLINK_ESCAPE',
      }),
    );
  });

  it('fails closed when an optional source file exceeds the per-file limit', async () => {
    const fixture = await createWorkspace();
    const oversizedPath = path.join(fixture.root, 'components', 'oversized.bin');
    await fs.mkdir(path.dirname(oversizedPath), { recursive: true });
    await fs.writeFile(oversizedPath, Buffer.alloc(16 * 1024 * 1024 + 1));

    await expect(verify(fixture)).rejects.toEqual(
      expect.objectContaining<Partial<MoAgentEvidenceVerificationError>>({
        code: 'EVIDENCE_ARTIFACT_TOO_LARGE',
      }),
    );
  });

  it('absorbs one transient persistent-preview hand-off failure without an Agent turn', async () => {
    const fixture = await createWorkspace();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('starting', { status: 503 }))
      .mockResolvedValueOnce(new Response('<main>ready</main>', { status: 200 }));

    const decision = await verify({
      ...fixture,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision.verdict).toBe('accepted');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never fetches a non-local preview and returns an infrastructure retry verdict', async () => {
    const fixture = await createWorkspace();
    const fetchImpl = readyFetch();

    const decision = await verify({
      ...fixture,
      preview: { url: 'https://example.com/dashboard', port: 443 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toMatchObject({
      verdict: 'retry_infrastructure',
      reasonCodes: ['PREVIEW_URL_NOT_LOCAL'],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when the durable MissionSpec hash does not match the supplied spec', async () => {
    const fixture = await createWorkspace();

    await expect(verify({
      ...fixture,
      missionSpecSha256: `sha256:${'0'.repeat(64)}`,
    })).rejects.toEqual(expect.objectContaining<Partial<MoAgentEvidenceVerificationError>>({
      code: 'MISSION_SPEC_HASH_MISMATCH',
    }));
  });
});
