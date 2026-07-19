import type { MemoryIntegrationConfig } from './config';
import type { MemoryCapability, MemoryServiceInfo } from './types';

export function memoryCompatibilityIssues(
  info: MemoryServiceInfo,
  config: MemoryIntegrationConfig,
  requiredCapabilities: readonly MemoryCapability[],
): string[] {
  const advertised = new Set(info.capabilities);
  const missing = requiredCapabilities
    .filter((capability) => !advertised.has(capability))
    .map((capability) => `capability:${capability}`);
  const production = config.requireProductionReady && !info.productionReady
    ? [
        'production:not-ready',
        ...info.productionBlockers.map((blocker) => `blocker:${blocker}`),
      ]
    : [];
  return [...missing, ...production];
}
