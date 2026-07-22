import { describe, expect, it } from 'vitest';

import { compileMoAgentMissionSpec } from './compiler';
import { createTestMissionDefinition } from './test-support';

const CREATED_AT = '2026-07-15T04:00:00.000Z';

type CompileOverrides = Partial<Parameters<typeof compileMoAgentMissionSpec>[0]> & {
  expectedArtifacts?: readonly string[];
};

function compile(overrides: CompileOverrides = {}) {
  const {
    expectedArtifacts = [
      'custom/result.json',
      '.data-agent/validation.json',
      '.data-agent/state.json',
    ],
    maxRepairAttempts = 2,
    definition,
    ...rest
  } = overrides;
  return compileMoAgentMissionSpec({
    projectId: 'project-mission',
    requestId: 'request-mission',
    objective: '生成可验证的量化看板',
    capabilityId: 'technical_analysis',
    runPlanId: 'request-mission',
    composition: {
      profileId: 'test.data-agent',
      profileVersion: '1.0.0',
      domainPackIds: ['test.data'],
      deliveryPackId: 'workspace.next-dashboard',
    },
    entities: [
      { entityType: 'test.entity', canonicalId: '600519' },
      { entityType: 'test.entity', canonicalId: '300750' },
    ],
    maxRepairAttempts,
    definition: definition ?? createTestMissionDefinition({
      maxRepairAttempts,
      expectedArtifacts,
    }),
    createdAt: CREATED_AT,
    ...rest,
  });
}

describe('MoAgent Mission compiler', () => {
  it('compiles deterministically after normalizing unordered and duplicate inputs', () => {
    const first = compile({
      entities: [
        { entityType: 'test.entity', canonicalId: '600519' },
        { entityType: 'test.entity', canonicalId: ' 300750 ' },
        { entityType: 'test.entity', canonicalId: '600519' },
      ],
      expectedArtifacts: [
        'custom/result.json',
        './custom/result.json',
        '.data-agent/state.json',
      ],
    });
    const second = compile({
      entities: [
        { entityType: 'test.entity', canonicalId: '300750' },
        { entityType: 'test.entity', canonicalId: '600519' },
      ],
      expectedArtifacts: [
        '.data-agent/state.json',
        'custom/result.json',
      ],
    });

    expect(first).toEqual(second);
    expect(first.expectedEntities).toEqual([
      { entityType: 'test.entity', canonicalId: '300750' },
      { entityType: 'test.entity', canonicalId: '600519' },
    ]);
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
    expect(byPath.get('.data-agent/validation.json')).toMatchObject({
      role: 'evidence',
      mutability: 'derived',
      required: true,
    });
    expect(byPath.get('.data-agent/state.json')).toMatchObject({
      role: 'control',
      mutability: 'mutable',
      required: true,
    });
    expect(byPath.get('components/**')).toMatchObject({
      role: 'subject',
      mutability: 'frozen',
      required: false,
    });
    expect(byPath.get('data/final/**')).toMatchObject({
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

  it('rejects artifact paths that can escape the workspace', () => {
    expect(() => compile({ expectedArtifacts: ['../outside/result.json'] })).toThrow(
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
