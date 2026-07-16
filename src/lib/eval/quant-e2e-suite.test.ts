import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  attestProductControlEvidence,
  loadQuantE2eSuite,
} = require('../../../scripts/checks/quant-e2e-suite.js') as {
  loadQuantE2eSuite(options?: Record<string, unknown>): {
    id: string;
    schemaVersion: number;
    caseIds: string[];
    productControlCaseIds: string[];
    runtimeTestFiles: string[];
    scenarios: Record<string, {
      evidenceClass: string;
      caseIds: string[];
      runtimeTests: string[];
    }>;
    raw: Record<string, unknown>;
  };
  attestProductControlEvidence(
    evidence: unknown,
    options: Record<string, unknown>,
  ): { passed: boolean; problems: string[] };
};

function validProductControlEvidence() {
  const suite = loadQuantE2eSuite({ requireReleaseCoverage: true });
  const frameworkVersion = 'moagent:test';
  const buildRevision = 'build:test';
  const gitRevision = 'a'.repeat(40);
  const id = suite.productControlCaseIds[0];
  const runId = 'moagent_product_control';
  const requestId = 'request-product-control';
  const missionId = 'mission-product-control';
  const generationId = '11111111-1111-4111-8111-111111111111';
  const receiptId = 'receipt-accepted';
  const receiptHash = `sha256:${'b'.repeat(64)}`;
  const startedAt = '2026-07-16T00:00:00.000Z';
  const finishedAt = '2026-07-16T00:00:01.000Z';
  return {
    suite,
    frameworkVersion,
    buildRevision,
    gitRevision,
    evidence: {
      schemaVersion: 1,
      suiteId: suite.id,
      suiteSchemaVersion: suite.schemaVersion,
      frameworkVersion,
      buildRevision,
      gitRevision,
      startedAt,
      finishedAt,
      caseIds: suite.productControlCaseIds,
      passed: true,
      results: [{
        id,
        requestId,
        passed: true,
        failures: [],
        agentExecuted: true,
        agentExecution: {
          executed: true,
          cli: 'moagent',
          provider: 'moagent-trusted-renderer',
          model: 'moagent-deterministic-renderer-v1',
          frameworkVersion,
          buildRevision,
          gitRevision,
          requestId,
          missionId,
          generationId,
          missionStatus: 'completed',
          acceptedReceiptId: receiptId,
          acceptedReceiptHash: receiptHash,
          acceptedReceiptType: 'acceptance',
          acceptedReceiptVerdict: 'accepted',
          acceptedCandidateSource: 'moagent_submit_result',
          acceptedSourceRunId: runId,
          acceptedSourceRequestId: requestId,
          startedAt,
          completedAt: finishedAt,
          turns: 2,
          runIds: [runId],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedInputTokens: 0,
            cacheMissInputTokens: 0,
            reasoningTokens: 0,
          },
          tools: {
            total: 2,
            succeeded: 2,
            failed: 0,
            uncertain: 0,
            workspaceWriteSucceeded: 1,
            submitResultSucceeded: 1,
            unexpectedFailureCount: 0,
            succeededToolNames: ['apply_dashboard_spec', 'submit_result'],
          },
          runs: [{
            id: runId,
            requestId,
            status: 'candidate_complete',
            provider: 'moagent-trusted-renderer',
            model: 'moagent-deterministic-renderer-v1',
            frameworkVersion,
            buildRevision,
            turns: 2,
            startedAt,
            completedAt: finishedAt,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              cachedInputTokens: 0,
              cacheMissInputTokens: 0,
              reasoningTokens: 0,
            },
          }],
        },
        missionAcceptance: {
          missionId,
          generationId,
          status: 'completed',
          acceptedReceiptId: receiptId,
          acceptedReceiptHash: receiptHash,
          acceptedSourceRunId: runId,
          acceptedSourceRequestId: requestId,
          acceptedCandidateSource: 'moagent_submit_result',
        },
        validation: { status: 'passed', checks: [] },
        visualCheck: { passed: true },
        eventAudit: { errorCount: 0 },
      }],
    },
  };
}

describe('MoAgent release E2E suite', () => {
  it('requires all production scenarios and separates zero-model controls', () => {
    const suite = loadQuantE2eSuite({ requireReleaseCoverage: true });

    expect(suite).toMatchObject({
      schemaVersion: 2,
      caseIds: expect.arrayContaining([
        'stock-diagnosis-citic-custom-no-cards',
        'index-technical-hs300',
        'stock-fundamental-maotai',
        'portfolio-risk-adjustment',
      ]),
      productControlCaseIds: ['stock-diagnosis-citic-no-false-clarification'],
    });
    expect(suite.runtimeTestFiles.length).toBeGreaterThanOrEqual(4);
    expect(suite.scenarios).toHaveProperty('security-boundary');
    expect(suite.scenarios['security-boundary']).toMatchObject({
      evidenceClass: 'runtime_test',
      caseIds: [],
      runtimeTests: expect.arrayContaining([
        'src/lib/agent/context/trusted-context-capsule.test.ts',
        'src/lib/agent/tools/filesystem.test.ts',
        'src/lib/agent/tools/structured-read.test.ts',
        'src/lib/agent/runtime/event-projector.test.ts',
      ]),
    });
  });

  it('rejects an incomplete release scenario matrix', () => {
    const suite = loadQuantE2eSuite({ requireReleaseCoverage: true });
    const raw = structuredClone(suite.raw);
    delete (raw.scenarios as Record<string, unknown>).repair;

    expect(() => loadQuantE2eSuite({
      suite: raw,
      requireReleaseCoverage: true,
    })).toThrow(/缺少场景 repair/);
  });

  it('attests a zero-token accepted deterministic product control', () => {
    const fixture = validProductControlEvidence();
    const result = attestProductControlEvidence(fixture.evidence, fixture);

    expect(result).toEqual({ passed: true, problems: [] });
  });

  it('rejects product controls that claim model token usage', () => {
    const fixture = validProductControlEvidence();
    const evidence = structuredClone(fixture.evidence);
    evidence.results[0].agentExecution.usage = {
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cachedInputTokens: 0,
      cacheMissInputTokens: 10,
      reasoningTokens: 0,
    };

    expect(attestProductControlEvidence(evidence, fixture)).toMatchObject({
      passed: false,
      problems: expect.arrayContaining([
        expect.stringContaining('零模型 Token'),
      ]),
    });
  });
});
