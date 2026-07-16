import { describe, expect, it } from 'vitest';

import { strategyPermissionAction } from './permission';

describe('strategyPermissionAction', () => {
  it('maps read-only data operations to quant.data.read', () => {
    for (const action of [
      'universe-members',
      'symbol-bars',
      'symbol-dividends',
      'realtime-quote',
      'intraday-bars',
      'ingestion-jobs',
      'sector-capital-flow',
    ]) {
      expect(strategyPermissionAction(action)).toBe('quant.data.read');
    }
  });

  it('maps executions and mutations to their distinct capabilities', () => {
    for (const action of ['run-scan', 'run-scan-now', 'a-share-screener', 'data-quality-scan']) {
      expect(strategyPermissionAction(action)).toBe('quant.strategy.run');
    }
    for (const action of [
      'add-universe-member',
      'control-ingestion-job',
      'run-ingestion-batch',
      'start-ingestion-autofill',
    ]) {
      expect(strategyPermissionAction(action)).toBe('quant.strategy.manage');
    }
  });

  it('uses strategy.run for prompt construction and rejects unknown actions', () => {
    expect(strategyPermissionAction(undefined)).toBe('quant.strategy.run');
    expect(strategyPermissionAction('')).toBe('quant.strategy.run');
    expect(strategyPermissionAction('drop-database')).toBeNull();
    expect(strategyPermissionAction({})).toBeNull();
  });
});
