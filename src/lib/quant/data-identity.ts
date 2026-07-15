type JsonRecord = Record<string, unknown>;

const SYMBOL_PATTERN = /^(?:6|0|3|5)\d{5}$/;
const ROOT_DATASET_KEYS = [
  'quote',
  'kline',
  'technicalIndicators',
  'financials',
  'fundamentalIndicators',
  'announcements',
  'backtest',
] as const;
const ROW_COLLECTION_KEYS = ['comparison', 'selectionRanking'] as const;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function symbol(value: unknown): string | null {
  const candidate = string(value);
  return candidate && SYMBOL_PATTERN.test(candidate) ? candidate : null;
}

function symbolArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(symbol);
  if (values.some((item) => item === null)) return null;
  const symbols = values as string[];
  return new Set(symbols).size === symbols.length ? symbols : null;
}

function sameOrderedSymbols(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameSymbolSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function rowSymbols(value: unknown): string[] | null {
  const rows = record(value)?.rows;
  if (!Array.isArray(rows)) return null;
  return symbolArray(rows.map((row) => record(row)?.symbol));
}

export interface QuantDatasetIdentityAssessment {
  ready: boolean;
  reasons: string[];
  runId: string | null;
  symbols: string[];
}

/**
 * Bind a platform-prepared final dataset to its authoritative planning run.
 * Every declared nested dataset identity is checked; multi-asset coverage must
 * exactly preserve the ordered plan universe rather than trusting self-reported
 * final-data arrays.
 */
export function assessQuantDatasetIdentity(
  runPlanValue: unknown,
  finalDataValue: unknown,
): QuantDatasetIdentityAssessment {
  const runPlan = record(runPlanValue);
  const finalData = record(finalDataValue);
  const reasons: string[] = [];
  const runId = string(runPlan?.runId);
  const finalRunId = string(finalData?.runId ?? finalData?.run_id);
  const plannedSymbols = symbolArray(runPlan?.symbols);

  if (!runPlan) reasons.push('run_plan_invalid');
  if (!finalData) reasons.push('final_data_invalid');
  if (!runId) reasons.push('run_id_missing');
  if (!finalRunId) reasons.push('final_run_id_missing');
  else if (runId && finalRunId !== runId) reasons.push('final_run_id_mismatch');
  if (!plannedSymbols || plannedSymbols.length === 0) reasons.push('planned_symbols_invalid');

  if (!finalData || !plannedSymbols?.length) {
    return { ready: reasons.length === 0, reasons, runId, symbols: plannedSymbols ?? [] };
  }

  const rootSymbol = symbol(finalData.symbol);
  if (!rootSymbol) reasons.push('final_root_symbol_missing');
  else if (rootSymbol !== plannedSymbols[0]) reasons.push('final_root_symbol_mismatch');

  const requestedSymbols = symbolArray(finalData.requestedSymbols);
  const fetchedSymbols = symbolArray(finalData.symbols);
  if (plannedSymbols.length > 1) {
    if (!requestedSymbols) reasons.push('final_requested_symbols_missing');
    else if (!sameOrderedSymbols(requestedSymbols, plannedSymbols)) {
      reasons.push('final_requested_symbols_mismatch');
    }
    if (!fetchedSymbols) reasons.push('final_fetched_symbols_missing');
    else if (!sameOrderedSymbols(fetchedSymbols, plannedSymbols)) {
      reasons.push('final_fetched_symbols_mismatch');
    }
  } else {
    if (requestedSymbols && !sameOrderedSymbols(requestedSymbols, plannedSymbols)) {
      reasons.push('final_requested_symbols_mismatch');
    }
    if (fetchedSymbols && !sameOrderedSymbols(fetchedSymbols, plannedSymbols)) {
      reasons.push('final_fetched_symbols_mismatch');
    }
  }

  for (const key of ROOT_DATASET_KEYS) {
    const dataset = record(finalData[key]);
    if (!dataset) continue;
    const datasetSymbol = symbol(dataset.symbol);
    if (!datasetSymbol) reasons.push(`${key}_symbol_missing`);
    else if (rootSymbol && datasetSymbol !== rootSymbol) reasons.push(`${key}_symbol_mismatch`);
  }

  const assets = Array.isArray(finalData.assets)
    ? finalData.assets.map(record)
    : null;
  if (plannedSymbols.length > 1) {
    const assetSymbols = assets && assets.every(Boolean)
      ? symbolArray(assets.map((asset) => asset?.symbol))
      : null;
    if (!assetSymbols) reasons.push('asset_symbols_missing');
    else if (!sameOrderedSymbols(assetSymbols, plannedSymbols)) reasons.push('asset_symbols_mismatch');

    for (const [index, asset] of (assets ?? []).entries()) {
      if (!asset) continue;
      const assetSymbol = symbol(asset.symbol);
      for (const key of ROOT_DATASET_KEYS) {
        const dataset = record(asset[key]);
        if (!dataset) continue;
        const datasetSymbol = symbol(dataset.symbol);
        if (!datasetSymbol) reasons.push(`assets[${index}].${key}_symbol_missing`);
        else if (assetSymbol && datasetSymbol !== assetSymbol) {
          reasons.push(`assets[${index}].${key}_symbol_mismatch`);
        }
      }
    }

    for (const key of ROW_COLLECTION_KEYS) {
      const rows = rowSymbols(finalData[key]);
      // Dataset presence/completeness belongs to the renderer prerequisite
      // contract. Identity only rejects non-empty rows that claim the wrong
      // symbol universe.
      if (rows?.length && !sameSymbolSet(rows, plannedSymbols)) {
        reasons.push(`${key}_symbols_mismatch`);
      }
    }
  }

  return {
    ready: reasons.length === 0,
    reasons: Array.from(new Set(reasons)),
    runId,
    symbols: plannedSymbols,
  };
}
