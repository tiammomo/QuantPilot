import { describe, expect, it } from 'vitest';

import type { MemoryIntegrationConfig } from './config';
import { memoryCompatibilityIssues } from './compatibility';
import {
  MEMORY_CHAT_CAPABILITIES,
  MEMORY_HTTP_CONTRACT,
  type MemoryServiceInfo,
} from './types';

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
  bearerToken: null,
  tokenBroker: null,
  expectedContract: MEMORY_HTTP_CONTRACT,
};

const info: MemoryServiceInfo = {
  name: 'Memory',
  version: '0.1.0',
  apiContract: MEMORY_HTTP_CONTRACT,
  capabilities: [...MEMORY_CHAT_CAPABILITIES],
  authMode: 'development',
  scopeSource: 'request',
  productionReady: false,
  productionBlockers: ['privacy.suppression-erasure'],
};

describe('memory service compatibility', () => {
  it('accepts the exact chat capability set for development', () => {
    expect(memoryCompatibilityIssues(info, config, MEMORY_CHAT_CAPABILITIES)).toEqual([]);
  });

  it('reports missing capabilities and production blockers', () => {
    expect(memoryCompatibilityIssues(
      { ...info, capabilities: ['recall.trace'] },
      { ...config, requireProductionReady: true },
      MEMORY_CHAT_CAPABILITIES,
    )).toEqual([
      'capability:recall.bitemporal',
      'capability:recall.context-projection',
      'production:not-ready',
      'blocker:privacy.suppression-erasure',
    ]);
  });
});
