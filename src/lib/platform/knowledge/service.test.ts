import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeIntegrationConfig } from './config';
import type { GovernedKnowledgePort } from './port';
import { prepareGovernedKnowledge, recordGovernedKnowledgeUsage } from './service';

const config: KnowledgeIntegrationConfig = {
  enabled: true,
  required: false,
  apiUrl: 'https://knowledge.example',
  purpose: 'quant-research',
  spaces: ['https://knowledge.example/spaces/research'],
  timeoutMs: 1_000,
  maxContextCharacters: 4_000,
  supportedObligations: ['cite', 'no-train'],
  bearerToken: 'reader-token',
  oauth: null,
  expectedVersion: '0.1',
};

function port(): GovernedKnowledgePort {
  return {
    discover: vi.fn(async () => ({
      protocol: 'akep' as const,
      versions: ['0.1'],
      operations: ['query', 'receipt', 'usage'],
      profiles: ['reader'],
      supportedExtensions: ['https://knowledge.example/extensions/akep/context-pack/0.1'],
      baseUrl: 'https://knowledge.example/akep/0.1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })),
    checkReady: vi.fn(async () => undefined),
    createContextPack: vi.fn(async () => ({
      contextPackId: `urn:akep:context:sha256:${'a'.repeat(64)}`,
      contextDigest: `sha256:${'b'.repeat(64)}`,
      createdAt: '2026-07-19T00:00:00.000Z',
      exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      policyEpoch: 'epoch-1',
      purpose: 'quant-research',
      passages: [{
        citationId: 'urn:akep:citation:one',
        chunkId: 'chunk-1',
        rank: 1,
        recordId: 'https://knowledge.example/records/risk',
        revisionId: `urn:akep:sha256:${'c'.repeat(64)}`,
        score: 1,
        spaceId: 'https://knowledge.example/spaces/research',
        text: 'Disclose data freshness.',
        title: 'Evidence policy',
      }],
      citations: [{
        citationId: 'urn:akep:citation:one',
        chunkId: 'chunk-1',
        payloadDigest: `sha256:${'d'.repeat(64)}`,
        locator: { type: 'text-offset', start: 0, end: 23 },
        quote: 'Disclose data freshness.',
        recordId: 'https://knowledge.example/records/risk',
        revisionId: `urn:akep:sha256:${'c'.repeat(64)}`,
        spaceId: 'https://knowledge.example/spaces/research',
      }],
      obligations: ['cite'],
      quality: { decision: 'suitable' as const, reasons: [], citationCoverage: 1, lexicalCoverage: 1 },
      warnings: [],
    })),
    recordUsage: vi.fn(async () => ({
      usageId: 'urn:uuid:00000000-0000-4000-8000-000000000002',
      exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      spaceId: 'https://knowledge.example/spaces/research',
      policyEpoch: 'epoch-1',
      createdAt: '2026-07-19T00:00:01.000Z',
      feedbackUntil: '2026-08-18T00:00:01.000Z',
    })),
  };
}

describe('governed knowledge service', () => {
  it('prepares a bounded untrusted capsule and records accepted-run usage', async () => {
    const adapter = port();
    const preparation = await prepareGovernedKnowledge(
      { task: 'Build a risk dashboard', requestId: 'request-1' },
      { config, port: adapter },
    );

    expect(preparation.status).toBe('prepared');
    expect(preparation.capsule?.content).toContain('Disclose data freshness.');

    const usage = await recordGovernedKnowledgeUsage({
      capsule: preparation.capsule,
      requestId: 'request-1',
      taskCategory: 'risk-dashboard',
    }, { config, port: adapter });

    expect(usage.status).toBe('recorded');
    expect(adapter.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'quant-research',
        taskCategory: 'risk-dashboard',
        citations: [expect.objectContaining({ influence: 'seen' })],
      }),
      expect.stringContaining('quantpilot-knowledge-usage-request-1-'),
      'request-1',
    );
  });

  it('degrades optional failures without leaking the exception', async () => {
    const adapter = port();
    vi.mocked(adapter.discover).mockRejectedValue(new Error('secret endpoint'));

    await expect(prepareGovernedKnowledge(
      { task: 'Build a dashboard', requestId: 'request-2' },
      { config, port: adapter },
    )).resolves.toMatchObject({ status: 'unavailable', failureCode: 'INTEGRATION_ERROR' });
  });
});
