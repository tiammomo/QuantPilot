import { describe, expect, it, vi } from 'vitest';

import type { MemoryIntegrationConfig } from './config';
import { EvolvableMemoryHttpAdapter } from './evolvable-memory-http';
import { MEMORY_HTTP_CONTRACT } from './types';

const config: MemoryIntegrationConfig = {
  enabled: true,
  required: false,
  requireProductionReady: false,
  apiUrl: 'https://memory.example',
  tenantId: 'tenant-a',
  purpose: 'personalization',
  timeoutMs: 1_000,
  recallLimit: 6,
  maxProjectionCharacters: 2_000,
  bearerToken: 'test-token',
  tokenBroker: null,
  expectedContract: MEMORY_HTTP_CONTRACT,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'memory-request' },
  });
}

describe('EvolvableMemoryHttpAdapter', () => {
  it('negotiates the versioned contract without importing provider code', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      name: 'Memory',
      version: '0.1.0',
      api_contract: MEMORY_HTTP_CONTRACT,
      capabilities: ['recall.trace'],
      auth_mode: 'development',
      scope_source: 'request',
      production_ready: false,
      production_blockers: ['identity.trusted-jwt'],
    }));
    const adapter = new EvolvableMemoryHttpAdapter(config, fetcher);

    await expect(adapter.discover('quantpilot.test')).resolves.toMatchObject({
      apiContract: MEMORY_HTTP_CONTRACT,
      capabilities: ['recall.trace'],
    });
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://memory.example/');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(new Headers(init.headers).get('x-request-id')).toBe('quantpilot.test');
  });

  it('translates provider-neutral input into the external HTTP contract', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      observation_id: 'observation',
      candidate_id: 'candidate',
      record_id: 'record',
      revision_id: 'revision',
      sequence: 1,
      idempotent_replay: false,
    }, 201));
    const adapter = new EvolvableMemoryHttpAdapter(config, fetcher);

    await adapter.rememberPreference({
      tenantId: 'tenant-a',
      subjectId: 'user-a',
      source: 'explicit',
      idempotencyKey: 'event-1',
      key: 'output.detail_level',
      value: 'concise',
      context: { product: 'quantpilot' },
      evidenceText: 'Keep it concise',
      confidence: 0.95,
      purpose: 'personalization',
    }, 'event-1');

    const [, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token');
    expect(JSON.parse(String(init.body))).toMatchObject({
      tenant_id: 'tenant-a',
      subject_id: 'user-a',
      idempotency_key: 'event-1',
      evidence_text: 'Keep it concise',
    });
  });

  it('rejects an incompatible discovery contract', async () => {
    const adapter = new EvolvableMemoryHttpAdapter(
      config,
      vi.fn().mockResolvedValue(jsonResponse({
        name: 'Memory',
        version: '2.0.0',
        api_contract: 'other/v2',
        capabilities: [],
        auth_mode: 'development',
        scope_source: 'request',
        production_ready: false,
        production_blockers: ['identity.trusted-jwt'],
      })),
    );

    await expect(adapter.discover()).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CONTRACT',
    });
  });

  it('preserves an API gateway base path', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }));
    const adapter = new EvolvableMemoryHttpAdapter(
      { ...config, apiUrl: 'https://platform.example/internal/memory' },
      fetcher,
    );

    await adapter.checkReady();

    const [url] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://platform.example/internal/memory/readyz');
  });
});
