import type { PermissionAction } from '@/lib/auth/permissions';

const DATA_READ_ACTIONS = new Set([
  'universe-members',
  'symbol-bars',
  'symbol-dividends',
  'realtime-quote',
  'intraday-bars',
  'ingestion-jobs',
  'sector-capital-flow',
]);

const STRATEGY_RUN_ACTIONS = new Set([
  'run-scan',
  'run-scan-now',
  'a-share-screener',
  'data-quality-scan',
]);

const STRATEGY_MANAGE_ACTIONS = new Set([
  'add-universe-member',
  'control-ingestion-job',
  'run-ingestion-batch',
  'start-ingestion-autofill',
]);

export function strategyPermissionAction(action: unknown): PermissionAction | null {
  if (action === undefined || action === null || action === '') return 'quant.strategy.run';
  if (typeof action !== 'string') return null;
  if (DATA_READ_ACTIONS.has(action)) return 'quant.data.read';
  if (STRATEGY_RUN_ACTIONS.has(action)) return 'quant.strategy.run';
  if (STRATEGY_MANAGE_ACTIONS.has(action)) return 'quant.strategy.manage';
  return null;
}
