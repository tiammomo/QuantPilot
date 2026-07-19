import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeIntegrationConfig } from './config';
import { AkepHttpAdapter } from './akep-http';

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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'akep-request' },
  });
}

function discovery(baseUrl = 'https://knowledge.example/akep/0.1') {
  return {
    protocol: 'akep',
    versions: ['0.1'],
    operations: ['query', 'receipt', 'usage'],
    profiles: ['reader'],
    supportedExtensions: [{ uri: 'https://knowledge.example/extensions/akep/context-pack/0.1' }],
    baseUrl,
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

describe('AKEP HTTP adapter', () => {
  it('discovers a versioned same-authority contract without importing provider code', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(discovery()));
    const adapter = new AkepHttpAdapter(config, fetcher);

    await expect(adapter.discover('quantpilot-test')).resolves.toMatchObject({
      protocol: 'akep',
      versions: ['0.1'],
      baseUrl: 'https://knowledge.example/akep/0.1',
    });
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://knowledge.example/.well-known/akep');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it('creates a bounded context pack with a server-side credential', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse(discovery()))
      .mockResolvedValueOnce(jsonResponse({
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
          text: 'Always disclose data freshness.',
          title: 'Research evidence policy',
        }],
        citations: [{
          citationId: 'urn:akep:citation:one',
          chunkId: 'chunk-1',
          payloadDigest: `sha256:${'d'.repeat(64)}`,
          locator: { type: 'text-offset', start: 0, end: 31 },
          quote: 'Always disclose data freshness.',
          recordId: 'https://knowledge.example/records/risk',
          revisionId: `urn:akep:sha256:${'c'.repeat(64)}`,
          spaceId: 'https://knowledge.example/spaces/research',
        }],
        obligations: ['cite'],
        quality: {
          decision: 'suitable',
          reasons: [],
          citationCoverage: 1,
          lexicalCoverage: 1,
        },
        warnings: [],
      }));
    const adapter = new AkepHttpAdapter(config, fetcher);

    await adapter.discover();
    const pack = await adapter.createContextPack({
      task: 'Build a risk dashboard',
      purpose: 'quant-research',
      spaces: config.spaces,
      maxCharacters: 4_000,
      supportedObligations: ['cite', 'no-train'],
    });

    expect(pack.passages).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[1] as [URL, RequestInit];
    expect(url.toString()).toBe('https://knowledge.example/akep/0.1/context-packs');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer reader-token');
    expect(new Headers(init.headers).get('akep-version')).toBe('0.1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      purpose: 'quant-research',
      mode: 'lexical',
      budget: { maxCharacters: 4000 },
    });
  });

  it('rejects a discovery endpoint on another authority', async () => {
    const adapter = new AkepHttpAdapter(
      config,
      vi.fn().mockResolvedValue(jsonResponse(discovery('https://attacker.example/akep/0.1'))),
    );

    await expect(adapter.discover()).rejects.toMatchObject({
      code: 'UNTRUSTED_DISCOVERY_ENDPOINT',
    });
  });
});
