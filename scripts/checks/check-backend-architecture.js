#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const failures = [];
const warnings = [];
const infos = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function info(message) {
  infos.push(message);
}

function assertFile(relativePath) {
  if (!exists(relativePath)) {
    fail(`missing required architecture file: ${relativePath}`);
    return '';
  }
  return read(relativePath);
}

function assertIncludes(relativePath, terms) {
  const content = assertFile(relativePath);
  for (const term of terms) {
    if (!content.includes(term)) {
      fail(`${relativePath} should mention "${term}"`);
    }
  }
}

function lineCount(relativePath) {
  return read(relativePath).split(/\r?\n/).length;
}

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    warn(`unable to inspect tracked files with git ls-files: ${error.message}`);
    return [];
  }
}

function listFilesRecursive(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(relativePath);
    }
    return [relativePath];
  });
}

assertIncludes('docs/backend-capability-architecture.md', [
  'Hexagonal Architecture',
  'Controller',
  'Use Case',
  'Repository',
  'Provider Adapter',
  'Cache Aside',
  'ClickHouse',
  'TimescaleDB',
]);

assertIncludes('docs/architecture.md', ['后端语言边界', 'ClickHouse', 'Python']);
assertIncludes('docs/README.md', ['后端能力架构']);
assertIncludes('docs/project-structure.md', ['routers/', 'services/', 'repositories/', 'analytics/']);
assertIncludes('services/market-data/src/quantpilot_market_data/api.py', [
  'include_router(analytics_router)',
  'include_router(foundation_router)',
  'include_router(provider_candidates_router)',
  'create_backtest_router',
  'create_events_router',
  'create_fundamentals_router',
  'create_indicators_router',
  'include_router(ingestion_router)',
  'create_quotes_router',
  'create_registry_router',
  'create_research_router',
]);

const layerDocs = {
  'services/market-data/src/quantpilot_market_data/routers/README.md': [
    'Controller',
    'FastAPI',
    'services/',
  ],
  'services/market-data/src/quantpilot_market_data/services/README.md': [
    'Use Case',
    'cache-aside',
    'provider fallback',
  ],
  'services/market-data/src/quantpilot_market_data/repositories/README.md': [
    'Repository',
    'TimescaleDB',
    'PostgreSQL',
  ],
  'services/market-data/src/quantpilot_market_data/analytics/README.md': [
    'ClickHouse',
    'TimescaleDB',
    'degraded',
  ],
};

for (const [relativePath, terms] of Object.entries(layerDocs)) {
  assertIncludes(relativePath, terms);
}

assertIncludes('services/market-data/src/quantpilot_market_data/routers/analytics.py', [
  'APIRouter',
  'HTTPException',
  'sync_clickhouse_analytics',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/registry.py', [
  'APIRouter',
  'build_data_registry',
  '/registry',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/foundation.py', [
  'APIRouter',
  'get_foundation_status',
  'scan_data_quality',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/provider_candidates.py', [
  'APIRouter',
  'probe_provider_candidates',
  'CandidateProviderNotFoundError',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/backtests.py', [
  'APIRouter',
  'get_ma_crossover_backtest',
  'strategy_backtest_parameters',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/events.py', [
  'APIRouter',
  'get_announcements',
  'get_dividend_events',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/fundamentals.py', [
  'APIRouter',
  'get_financial_reports',
  'get_fundamental_indicators',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/indicators.py', [
  'APIRouter',
  'get_technical_indicators',
  'HistoricalKlineProvider',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/ingestion.py', [
  'APIRouter',
  'get_market_data_ingestion_jobs',
  'control_market_data_ingestion_job',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/quotes.py', [
  'APIRouter',
  'resolve_symbol',
  'get_history_quote',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/routers/research.py', [
  'APIRouter',
  'get_research_universes',
  'add_research_universe_member',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/analytics.py', [
  'get_clickhouse_analytics_health',
  'initialize_clickhouse_analytics',
  'sync_clickhouse_analytics',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/backtests.py', [
  'build_ma_crossover_backtest',
  'build_strategy_backtest',
  'read_cached_response',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/events.py', [
  'AnnouncementProvider',
  'DividendEventProvider',
  'read_cached_response',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/fundamentals.py', [
  'FinancialReportProvider',
  'build_fundamental_indicators',
  'read_cached_response',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/indicators.py', [
  'HistoricalKlineProvider',
  'build_technical_indicators',
  'read_cached_response',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/ingestion_jobs.py', [
  'list_ingestion_jobs',
  'control_ingestion_job',
  'IngestionJobControlResponse',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/quotes.py', [
  'SymbolResolverProvider',
  'RealtimeQuoteProvider',
  'intraday_redis_cache_key',
  'read_cached_response',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/research.py', [
  'ResearchUniverseProvider',
  'list_research_universes',
  'resolve_research_security',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/repositories/research.py', [
  'add_security_to_universe',
  'list_research_universes',
  '__all__',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/repositories/foundation.py', [
  'list_foundation_components',
  'run_data_quality_scan',
  '__all__',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/repositories/ingestion.py', [
  'list_ingestion_jobs',
  'update_ingestion_job_progress',
  '__all__',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/repositories/analytics.py', [
  'sync_clickhouse_daily_bars',
  '__all__',
]);

const backendPythonFiles = listFilesRecursive('services/market-data/src/quantpilot_market_data')
  .filter((file) => file.endsWith('.py'));
for (const file of backendPythonFiles) {
  const source = read(file);
  if (
    source.includes('from quantpilot_market_data.database import') ||
    source.includes('import quantpilot_market_data.database')
  ) {
    fail(`${file} must depend on database_core.py or repositories/*; database.py was removed`);
  }
}
if (exists('services/market-data/src/quantpilot_market_data/database.py')) {
  fail('database.py is a removed compatibility facade and must not be restored');
}
assertIncludes('services/market-data/src/quantpilot_market_data/services/caching.py', [
  'read_cached_response',
  'cache_response',
  'MarketDataCache',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/foundation.py', [
  'list_foundation_components',
  'list_factor_definitions',
  'list_trading_calendar_days',
  'run_data_quality_scan',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/provider_candidates.py', [
  'CANDIDATE_PROVIDERS',
  'get_candidate_provider',
  'probe_candidate_provider',
]);
assertIncludes('services/market-data/src/quantpilot_market_data/services/registry.py', [
  'ProviderRegistryTtls',
  'build_data_providers',
  'DataProviderInfo',
]);

const apiSource = assertFile('services/market-data/src/quantpilot_market_data/api.py');
if (apiSource.includes('@app.get(\n        "/api/v1/analytics/clickhouse/health"')) {
  fail('ClickHouse analytics endpoints should live in routers/analytics.py, not api.py');
}
if (apiSource.includes('DATA_PROVIDERS = [')) {
  fail('Data provider registry should live in services/registry.py, not api.py');
}
for (const legacyRoute of [
  '@app.get("/api/v1/foundation/status"',
  '@app.get("/api/v1/provider-candidates"',
  '@app.get("/api/v1/backtests/ma-crossover',
  '@app.get("/api/v1/indicators/technical',
  '@app.get("/api/v1/fundamentals/financials',
  '@app.get("/api/v1/events/announcements',
  '@app.get("/api/v1/symbols/resolve',
  '@app.get("/api/v1/quotes/realtime',
  '@app.get("/api/v1/quotes/history',
  '@app.get("/api/v1/research/universes',
  '@app.post("/api/v1/research/a-share/import-batch',
  '@app.get("/api/v1/research/bars',
  '@app.get("/api/v1/ingestion/jobs',
]) {
  if (apiSource.includes(legacyRoute)) {
    fail(`${legacyRoute} should live in a router module, not api.py`);
  }
}

const providerBase = assertFile('services/market-data/src/quantpilot_market_data/providers/base.py');
if (!/class\s+MarketDataProvider\(Protocol\)/.test(providerBase)) {
  fail('providers/base.py should expose MarketDataProvider Protocol');
}
if (!/class\s+HistoricalKlineProvider\(MarketDataProvider,\s*Protocol\)/.test(providerBase)) {
  fail('providers/base.py should expose HistoricalKlineProvider Protocol');
}

const packageJson = JSON.parse(assertFile('package.json'));
if (!packageJson.scripts?.['check:backend-architecture']) {
  fail('package.json should expose check:backend-architecture');
}

const generatedTracked = trackedFiles().filter((file) =>
  /(^|\/)(__pycache__|\.pytest_cache|\.ruff_cache|\.venv)(\/|$)|\.pyc$/.test(file)
);
if (generatedTracked.length > 0) {
  fail(`generated Python artifacts should not be tracked: ${generatedTracked.join(', ')}`);
}

const apiLines = lineCount('services/market-data/src/quantpilot_market_data/api.py');
if (apiLines > 1800) {
  warn(`api.py has ${apiLines} lines; new endpoints should move into routers/ and services/.`);
}

for (const message of infos) {
  console.log(`[backend-architecture] info: ${message}`);
}

for (const warning of warnings) {
  console.warn(`[backend-architecture] warning: ${warning}`);
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`[backend-architecture] ${message}`);
  }
  process.exit(1);
}

console.log('[backend-architecture] ok');
