#!/usr/bin/env node

import { EvolvableMemoryHttpAdapter } from '../../src/lib/platform/memory/evolvable-memory-http';
import { getMemoryIntegrationConfig } from '../../src/lib/platform/memory/config';

function requireProbeSubject(): string {
  const value = process.env.QUANTPILOT_MEMORY_PRODUCTION_PROBE_SUBJECT_ID?.trim();
  if (!value || value.length > 128) {
    throw new Error('QUANTPILOT_MEMORY_PRODUCTION_PROBE_SUBJECT_ID must name an authorized non-human probe subject.');
  }
  return value;
}

async function main(): Promise<void> {
  const config = getMemoryIntegrationConfig();
  if (!config.enabled || !config.required || !config.requireProductionReady) {
    throw new Error('Production Memory gate requires ENABLED=1, REQUIRED=1 and REQUIRE_PRODUCTION_READY=1.');
  }
  if (config.bearerToken || !config.tokenBroker) {
    throw new Error('Production Memory gate requires the scoped token broker and forbids a static bearer token.');
  }
  const subjectId = requireProbeSubject();
  const adapter = new EvolvableMemoryHttpAdapter(config);
  const requestId = `quantpilot-memory-production-${Date.now()}`;
  const info = await adapter.discover(requestId);
  if (!info.productionReady) {
    throw new Error(`Memory production blockers: ${info.productionBlockers.join(', ') || 'unknown'}`);
  }
  if (info.authMode !== 'jwt' || info.scopeSource !== 'access_token') {
    throw new Error(`Memory identity boundary is ${info.authMode}/${info.scopeSource}, expected jwt/access_token.`);
  }
  await adapter.checkReady(requestId);
  const preferences = await adapter.listPreferences({
    tenantId: config.tenantId,
    subjectId,
    purpose: config.purpose,
  }, requestId);
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    apiContract: info.apiContract,
    productionReady: info.productionReady,
    identity: `${info.authMode}/${info.scopeSource}`,
    tokenBroker: 'short-lived-scoped-token',
    processingGrantProbe: 'passed',
    visiblePreferenceCount: preferences.length,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
});
