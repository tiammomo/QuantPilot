import type {
  MoAgentJsonArtifactConfiguration,
  MoAgentJsonArtifactIdentityResult,
} from '@/lib/agent/tools';

function normalizedSymbol(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return String(value).match(/\d{6}/u)?.[0] ?? null;
}

function financeArtifactSymbols(value: unknown): Set<string> {
  const symbols = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return symbols;
  const root = value as Record<string, unknown>;
  const add = (candidate: unknown) => {
    const symbol = normalizedSymbol(candidate);
    if (symbol) symbols.add(symbol);
  };
  add(root.symbol);
  add(root.code);
  if (root.quote && typeof root.quote === 'object' && !Array.isArray(root.quote)) {
    const quote = root.quote as Record<string, unknown>;
    add(quote.symbol);
    add(quote.code);
  }
  if (Array.isArray(root.assets)) {
    for (const asset of root.assets) {
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) continue;
      const record = asset as Record<string, unknown>;
      add(record.symbol);
      add(record.code);
      if (record.quote && typeof record.quote === 'object' && !Array.isArray(record.quote)) {
        add((record.quote as Record<string, unknown>).symbol);
      }
    }
  }
  return symbols;
}

function validateSymbolIdentity(
  root: unknown,
  requestedIdentity: string,
): MoAgentJsonArtifactIdentityResult {
  const availableIdentities = [...financeArtifactSymbols(root)].sort();
  return {
    matches: availableIdentities.includes(requestedIdentity),
    availableIdentities,
  };
}

export const FINANCE_JSON_ARTIFACT_CONFIGURATION: MoAgentJsonArtifactConfiguration = {
  paths: {
    final_dashboard: 'data_file/final/dashboard-data.json',
    sources_evidence: 'evidence/sources.json',
    data_quality_evidence: 'evidence/data_quality.json',
    query_rewrite: '.data-agent/finance-query-rewrite.json',
    run_plan: '.data-agent/finance-run-plan.json',
    task: '.data-agent/task.json',
    plan: '.data-agent/plan.json',
    validation_report: '.data-agent/validation.json',
  },
  preferredObjectKeys: [
    'symbol',
    'name',
    'price',
    'close',
    'latest_close',
    'change_percent',
    'periodReturn',
    'return20d',
    'maxDrawdown',
    'volatility20d',
    'date',
    'report_date',
    'latest_report_date',
    'title',
    'summary',
    'primary_view',
    'risk_disclaimer',
    'status',
    'method',
    'rows',
    'data_quality',
  ],
  resolveAlias(requestedPath) {
    const normalized = requestedPath.trim().replace(/^\/+/u, '').replace(/^\.\//u, '');
    const symbol = normalized
      .match(/^public\/data\/(\d{6})(?:\.(?:sh|sz))?\.json$/iu)?.[1];
    if (
      /^(?:public\/data\/(?:dashboard(?:-data)?|\d{6}(?:\.(?:sh|sz))?)|data\/dashboard(?:-data)?)\.json$/iu
        .test(normalized)
    ) {
      return {
        artifactId: 'final_dashboard',
        ...(symbol ? { requestedIdentity: symbol } : {}),
      };
    }
    return null;
  },
  validateAliasIdentity: validateSymbolIdentity,
  toolDescription: 'Batch-query all required RFC 6901 JSON Pointers from one Finance workspace JSON artifact in a single call (maximum 16). Prefer artifact="final_dashboard" and request quote, K-line/technical summaries, financials, events, metrics, and conclusion together.',
  artifactDescription: 'Authoritative Finance artifact handle. Prefer final_dashboard instead of guessing a public/data path.',
  pathDescription: 'Workspace-relative JSON file. Omit when artifact is supplied. Finance dashboard data is data_file/final/dashboard-data.json.',
  pointersDescription: 'All needed Finance paths in one array, for example ["/quote","/kline/bars","/technicalIndicators/summary","/financials/reports","/announcements/announcements","/computedMetrics","/conclusion"].',
};
