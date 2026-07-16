import { describe, expect, it } from 'vitest';

import { compileMoAgentMissionSpec } from './compiler';

const CREATED_AT = '2026-07-15T04:00:00.000Z';

function compile(overrides: Partial<Parameters<typeof compileMoAgentMissionSpec>[0]> = {}) {
  return compileMoAgentMissionSpec({
    projectId: 'project-mission',
    requestId: 'request-mission',
    objective: '生成可验证的量化看板',
    capabilityId: 'technical_analysis',
    runPlanId: 'request-mission',
    symbols: ['600519', '300750'],
    expectedArtifacts: [
      'custom/result.json',
      '.quantpilot/validation.json',
      '.quantpilot/events.jsonl',
    ],
    maxRepairAttempts: 2,
    createdAt: CREATED_AT,
    ...overrides,
  });
}

describe('MoAgent Mission compiler', () => {
  it('compiles deterministically after normalizing unordered and duplicate inputs', () => {
    const first = compile({
      symbols: ['600519', ' 300750 ', '600519'],
      expectedArtifacts: [
        'custom/result.json',
        './custom/result.json',
        '.quantpilot/events.jsonl',
      ],
    });
    const second = compile({
      symbols: ['300750', '600519'],
      expectedArtifacts: [
        '.quantpilot/events.jsonl',
        'custom/result.json',
      ],
    });

    expect(first).toEqual(second);
    expect(first.expectedSymbols).toEqual(['300750', '600519']);
    expect(first.artifacts.map((artifact) => artifact.path)).toEqual(
      [...first.artifacts.map((artifact) => artifact.path)].sort(),
    );
  });

  it('separates frozen subjects, derived evidence, and mutable control artifacts', () => {
    const spec = compile();
    const byPath = new Map(spec.artifacts.map((artifact) => [artifact.path, artifact]));

    expect(byPath.get('app/page.tsx')).toMatchObject({
      role: 'subject',
      mutability: 'frozen',
      required: true,
    });
    expect(byPath.get('custom/result.json')).toMatchObject({
      role: 'subject',
      mutability: 'frozen',
      required: true,
    });
    expect(byPath.get('.quantpilot/validation.json')).toMatchObject({
      role: 'evidence',
      mutability: 'derived',
      required: true,
    });
    expect(byPath.get('.quantpilot/generation-state.json')).toMatchObject({
      role: 'control',
      mutability: 'mutable',
      required: true,
    });
    expect(byPath.get('.quantpilot/events.jsonl')).toMatchObject({
      role: 'control',
      mutability: 'mutable',
      required: true,
    });
    expect(byPath.get('components/**')).toMatchObject({
      role: 'subject',
      mutability: 'frozen',
      required: false,
    });
    expect(byPath.get('data_file/final/**')).toMatchObject({
      role: 'subject',
      mutability: 'frozen',
      required: false,
    });
    expect(byPath.get('evidence/**')).toMatchObject({
      role: 'evidence',
      mutability: 'derived',
      required: false,
    });
    expect(byPath.get('next.config.*')).toMatchObject({
      role: 'subject',
      required: false,
    });
    expect(byPath.get('package-lock.json')).toMatchObject({
      role: 'subject',
      required: false,
    });
  });

  it('does not allow callers to inject their own artifact glob surface', () => {
    expect(() => compile({ expectedArtifacts: ['outside/**'] })).toThrow(
      'Invalid MissionSpec artifact path',
    );
  });

  it('places persistent preview readiness before final evidence verification', () => {
    const spec = compile();
    const previewIndex = spec.nodes.findIndex((node) => node.key === 'preview_readiness');
    const verifierIndex = spec.nodes.findIndex((node) => node.key === 'evidence_verification');
    const verifier = spec.nodes[verifierIndex];

    expect(previewIndex).toBeGreaterThan(-1);
    expect(verifierIndex).toBeGreaterThan(previewIndex);
    expect(verifier.dependencies).toEqual(['validation', 'preview_readiness']);
    expect(verifier.acceptancePredicates).toContain('preview_http_ready');
  });

  it('allows disclosed evidence quality warnings while keeping other checks strict', () => {
    expect(compile().allowedValidationWarnings).toEqual(['evidence_files']);
  });
});
