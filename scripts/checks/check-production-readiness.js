#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const ROOT = process.cwd();
const args = process.argv.slice(2);
const requireBootstrap = args.includes('--require-bootstrap');
const explicitEnvIndex = args.findIndex((value) => value === '--env-file');
const explicitEnvFile = explicitEnvIndex >= 0 ? args[explicitEnvIndex + 1] : null;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const PLACEHOLDER_PATTERN = /(?:change[-_ ]?me|replace[-_ ]?with|example|quantpilot_dev_password|your[-_ ]|<.+>)/i;

function loadEnvironment() {
  const loaded = {};
  const files = explicitEnvFile
    ? [explicitEnvFile]
    : ['.env', '.env.local', '.env.production', '.env.production.local'];
  for (const file of files) {
    const absolute = path.resolve(ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    Object.assign(loaded, dotenv.parse(fs.readFileSync(absolute)));
  }
  return { ...loaded, ...process.env };
}

const environment = loadEnvironment();
const errors = [];
const warnings = [];

function value(name) {
  return String(environment[name] || '').trim();
}

function flag(name, fallback = false) {
  const normalized = value(name).toLowerCase();
  if (!normalized) return fallback;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  errors.push(`${name} 必须是明确的 true/false 或 1/0。`);
  return fallback;
}

function requireValue(name, predicate, message) {
  const configured = value(name);
  if (!configured || !predicate(configured)) errors.push(message || `${name} 未正确配置。`);
  return configured;
}

function requireFlag(name, expected = true) {
  if (flag(name, !expected) !== expected) {
    errors.push(`${name} 必须设置为 ${expected ? '1' : '0'}。`);
  }
}

function secureSecret(name, minimum = 32) {
  return requireValue(
    name,
    (configured) => configured.length >= minimum && !PLACEHOLDER_PATTERN.test(configured),
    `${name} 必须是至少 ${minimum} 字符的非占位随机值。`,
  );
}

function httpsUrl(name) {
  return requireValue(name, (configured) => {
    try {
      return new URL(configured).protocol === 'https:';
    } catch {
      return false;
    }
  }, `${name} 必须是有效的 HTTPS URL。`);
}

if (value('QUANTPILOT_DEGRADATION_MODE') !== 'strict') {
  errors.push('QUANTPILOT_DEGRADATION_MODE 必须设置为 strict。');
}
if (value('NODE_ENV') !== 'production') {
  errors.push('NODE_ENV 必须设置为 production。');
}
if (value('QUANTPILOT_AUTH_MODE') !== 'local') {
  errors.push('QUANTPILOT_AUTH_MODE 必须设置为 local。');
}
if (value('MOAGENT_DISPATCH_MODE') !== 'worker') {
  errors.push('MOAGENT_DISPATCH_MODE 必须设置为 worker，并部署独立 generation worker。');
}
const workerConcurrency = Number(value('MOAGENT_WORKER_CONCURRENCY'));
const globalWorkerConcurrency = Number(value('MOAGENT_WORKER_GLOBAL_CONCURRENCY'));
const workerSlotTtlMs = Number(value('MOAGENT_WORKER_SLOT_LEASE_TTL_MS'));
const workerSlotHeartbeatMs = Number(value('MOAGENT_WORKER_SLOT_HEARTBEAT_INTERVAL_MS'));
if (!Number.isSafeInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 16) {
  errors.push('MOAGENT_WORKER_CONCURRENCY 必须是 1..16 的整数。');
}
if (
  !Number.isSafeInteger(globalWorkerConcurrency) ||
  globalWorkerConcurrency < 1 ||
  globalWorkerConcurrency > 256
) {
  errors.push('MOAGENT_WORKER_GLOBAL_CONCURRENCY 必须是 1..256 的整数。');
}
if (
  Number.isSafeInteger(workerConcurrency) &&
  Number.isSafeInteger(globalWorkerConcurrency) &&
  workerConcurrency > globalWorkerConcurrency
) {
  errors.push('单进程 Worker 并发不能超过数据库全局 Worker 并发。');
}
if (
  !Number.isSafeInteger(workerSlotTtlMs) ||
  workerSlotTtlMs < 1000 ||
  workerSlotTtlMs > 86_400_000
) {
  errors.push('MOAGENT_WORKER_SLOT_LEASE_TTL_MS 必须是 1000..86400000 的整数。');
}
if (
  !Number.isSafeInteger(workerSlotHeartbeatMs) ||
  workerSlotHeartbeatMs < 1 ||
  workerSlotHeartbeatMs >= workerSlotTtlMs
) {
  errors.push('Worker slot heartbeat 必须是正整数并严格小于 slot lease TTL。');
}

const appUrl = httpsUrl('NEXT_PUBLIC_APP_URL');
const authUrl = httpsUrl('BETTER_AUTH_URL');
if (appUrl && authUrl) {
  try {
    if (new URL(appUrl).origin !== new URL(authUrl).origin) {
      errors.push('NEXT_PUBLIC_APP_URL 与 BETTER_AUTH_URL 必须使用同一 origin。');
    }
  } catch {
    // URL 格式错误已经由 httpsUrl 报告。
  }
}

const trustedOrigins = value('QUANTPILOT_AUTH_TRUSTED_ORIGINS')
  .split(',')
  .map((item) => item.trim().replace(/\/$/, ''))
  .filter(Boolean);
if (appUrl && !trustedOrigins.includes(appUrl.replace(/\/$/, ''))) {
  errors.push('QUANTPILOT_AUTH_TRUSTED_ORIGINS 必须包含 NEXT_PUBLIC_APP_URL。');
}

requireFlag('QUANTPILOT_AUTH_SECURE_COOKIES');
requireFlag('QUANTPILOT_SECURITY_HSTS');
requireFlag('QUANTPILOT_AUTH_ALLOW_SIGNUP', false);
requireFlag('QUANTPILOT_DATABASE_ENABLED');
requireFlag('QUANTPILOT_DATABASE_REQUIRED');
requireFlag('QUANTPILOT_MARKET_API_ENABLED');
requireFlag('QUANTPILOT_MARKET_API_REQUIRED');
requireFlag('QUANTPILOT_MARKET_MAINTENANCE_ENABLED');
requireFlag('QUANTPILOT_REDIS_CACHE_ENABLED');
requireFlag('QUANTPILOT_REDIS_REQUIRED');
requireFlag('QUANTPILOT_OBSERVABILITY_ENABLED');
requireFlag('QUANTPILOT_OBSERVABILITY_REQUIRED');
requireFlag('QUANTPILOT_GENERATED_SANDBOX');
requireFlag('QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE', false);
requireFlag('QUANTPILOT_REQUIRE_HIDDEN_EVAL');
requireFlag('QUANTPILOT_REQUIRE_PRODUCTION_JUDGE_CALIBRATION');
requireFlag('QUANTPILOT_REQUIRE_INDEPENDENT_JUDGE');

secureSecret('QUANTPILOT_AUTH_SECRET');
secureSecret('QUANTPILOT_ADMIN_TOKEN');
secureSecret('QUANTPILOT_MARKET_ADMIN_TOKEN');
requireValue('ENCRYPTION_KEY', (configured) => /^[0-9a-f]{64}$/i.test(configured), 'ENCRYPTION_KEY 必须是 64 位十六进制随机值。');
requireValue(
  'PROJECTS_DIR',
  (configured) => path.isAbsolute(configured) && configured !== '/' && !PLACEHOLDER_PATTERN.test(configured),
  'PROJECTS_DIR 必须是非占位的绝对持久化目录，且不能是文件系统根目录。',
);
requireValue(
  'MOAGENT_WORKSPACE_NAMESPACE',
  (configured) => /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(configured) && !PLACEHOLDER_PATTERN.test(configured),
  'MOAGENT_WORKSPACE_NAMESPACE 必须是部署集群内稳定且非占位的工作空间命名空间。',
);

const modelPortEnabled = flag('QUANTPILOT_MODELPORT_ENABLED', true);
if (modelPortEnabled) {
  requireFlag('QUANTPILOT_MODELPORT_REQUIRED');
  httpsUrl('QUANTPILOT_MODELPORT_URL');
  secureSecret('MODELPORT_API_KEY', 16);
  for (const name of [
    'QUANTPILOT_MODELPORT_ORGANIZATION_ID',
    'QUANTPILOT_MODELPORT_PROJECT_ID',
    'QUANTPILOT_MODELPORT_ENVIRONMENT_ID',
  ]) {
    requireValue(
      name,
      (configured) => /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(configured) && !PLACEHOLDER_PATTERN.test(configured),
      `${name} 必须是稳定、非占位的隔离标识。`,
    );
  }
} else {
  requireFlag('QUANTPILOT_MODELPORT_REQUIRED', false);
  secureSecret('DEEPSEEK_API_KEY', 16);
  warnings.push('ModelPort 已关闭：生产环境将仅保留显式选择的 DeepSeek 官方直连，默认 Qwen 不可用。');
}

const knowledgeEnabled = flag('QUANTPILOT_KNOWLEDGE_ENABLED', false);
if (knowledgeEnabled) {
  requireFlag('QUANTPILOT_KNOWLEDGE_REQUIRED');
  httpsUrl('QUANTPILOT_KNOWLEDGE_API_URL');
  requireValue(
    'QUANTPILOT_KNOWLEDGE_PURPOSE',
    (configured) => /^[a-z][a-z0-9._:-]{0,127}$/.test(configured),
    'QUANTPILOT_KNOWLEDGE_PURPOSE 必须是稳定的 purpose 标识。',
  );
  const spaces = value('QUANTPILOT_KNOWLEDGE_SPACES').split(',').map((item) => item.trim()).filter(Boolean);
  if (spaces.length === 0 || spaces.some((configured) => {
    try {
      const parsed = new URL(configured);
      return parsed.protocol !== 'https:' || Boolean(parsed.username || parsed.password);
    } catch {
      return true;
    }
  })) {
    errors.push('QUANTPILOT_KNOWLEDGE_SPACES 必须包含至少一个无凭据的 HTTPS Space URI。');
  }
  requireFlag('QUANTPILOT_KNOWLEDGE_PROJECT_SPACES_ENABLED');
  httpsUrl('QUANTPILOT_KNOWLEDGE_PROJECT_SPACE_BASE_URL');
  if (value('QUANTPILOT_KNOWLEDGE_BEARER_TOKEN')) {
    errors.push('生产环境禁止 QUANTPILOT_KNOWLEDGE_BEARER_TOKEN，必须使用 OAuth 短期凭据。');
  }
  httpsUrl('QUANTPILOT_KNOWLEDGE_OAUTH_TOKEN_URL');
  requireValue('QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_ID', (configured) => configured.length <= 256 && !configured.includes(':'), 'QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_ID 无效。');
  secureSecret('QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_SECRET', 16);
  httpsUrl('QUANTPILOT_KNOWLEDGE_OAUTH_RESOURCE');
} else {
  requireFlag('QUANTPILOT_KNOWLEDGE_REQUIRED', false);
}

const memoryEnabled = flag('QUANTPILOT_MEMORY_ENABLED', false);
if (memoryEnabled) {
  requireFlag('QUANTPILOT_MEMORY_REQUIRED');
  requireFlag('QUANTPILOT_MEMORY_REQUIRE_PRODUCTION_READY');
  httpsUrl('QUANTPILOT_MEMORY_API_URL');
  requireValue(
    'QUANTPILOT_MEMORY_TENANT_ID',
    (configured) => /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(configured) && !PLACEHOLDER_PATTERN.test(configured),
    'QUANTPILOT_MEMORY_TENANT_ID 必须是当前产品独占的稳定 tenant。',
  );
  if (value('QUANTPILOT_MEMORY_BEARER_TOKEN')) {
    errors.push('生产环境禁止 QUANTPILOT_MEMORY_BEARER_TOKEN，必须使用短期 Token Broker。');
  }
  httpsUrl('QUANTPILOT_MEMORY_TOKEN_BROKER_URL');
  requireValue('QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_ID', (configured) => configured.length <= 256 && !configured.includes(':'), 'QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_ID 无效。');
  secureSecret('QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_SECRET', 16);
  requireValue('QUANTPILOT_MEMORY_TOKEN_AUDIENCE', (configured) => configured.length <= 512, 'QUANTPILOT_MEMORY_TOKEN_AUDIENCE 未正确配置。');
  requireValue(
    'QUANTPILOT_MEMORY_PRODUCTION_PROBE_SUBJECT_ID',
    (configured) => /^[a-z0-9][a-z0-9._:-]{1,127}$/i.test(configured) && !PLACEHOLDER_PATTERN.test(configured),
    'QUANTPILOT_MEMORY_PRODUCTION_PROBE_SUBJECT_ID 必须是已授权的非人类探针 subject。',
  );
} else {
  requireFlag('QUANTPILOT_MEMORY_REQUIRED', false);
  requireFlag('QUANTPILOT_MEMORY_REQUIRE_PRODUCTION_READY', false);
}

requireValue('DATABASE_URL', (configured) => {
  try {
    const parsed = new URL(configured);
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && Boolean(parsed.pathname.replace('/', ''))
      && !PLACEHOLDER_PATTERN.test(configured);
  } catch {
    return false;
  }
}, 'DATABASE_URL 必须是非占位 PostgreSQL URL。');
requireValue('REDIS_URL', (configured) => {
  try {
    return ['redis:', 'rediss:'].includes(new URL(configured).protocol);
  } catch {
    return false;
  }
}, 'REDIS_URL 必须是有效的 redis:// 或 rediss:// URL。');
requireValue('QUANTPILOT_MARKET_API_URL', (configured) => {
  try {
    return ['http:', 'https:'].includes(new URL(configured).protocol);
  } catch {
    return false;
  }
}, 'QUANTPILOT_MARKET_API_URL 必须是有效的内部 HTTP(S) URL。');
requireValue('LOKI_URL', (configured) => {
  try {
    return ['http:', 'https:'].includes(new URL(configured).protocol);
  } catch {
    return false;
  }
}, 'LOKI_URL 必须是有效的 HTTP(S) URL。');
requireValue(
  'QUANTPILOT_HIDDEN_EVAL_CASES_PATH',
  (configured) => path.isAbsolute(configured) && fs.existsSync(configured),
  'QUANTPILOT_HIDDEN_EVAL_CASES_PATH 必须是已注入的绝对文件路径。',
);
requireValue(
  'QUANTPILOT_EVAL_JUDGE_CALIBRATION_PATH',
  (configured) => path.isAbsolute(configured) && fs.existsSync(configured),
  'QUANTPILOT_EVAL_JUDGE_CALIBRATION_PATH 必须是已注入的绝对文件路径。',
);
if (value('QUANTPILOT_EVAL_DATASET_VISIBILITY') !== 'hidden') {
  errors.push('QUANTPILOT_EVAL_DATASET_VISIBILITY 必须设置为 hidden。');
}
secureSecret('QUANTPILOT_REPLAY_HASH_KEY', 16);

requireValue(
  'QUANTPILOT_MARKET_MAINTENANCE_UNIVERSE_ID',
  (configured) => /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(configured),
  'QUANTPILOT_MARKET_MAINTENANCE_UNIVERSE_ID 必须是稳定的股票池 ID。',
);
requireValue(
  'QUANTPILOT_MARKET_FRESHNESS_MIN_SYMBOLS',
  (configured) => Number.isSafeInteger(Number(configured)) && Number(configured) >= 1,
  'QUANTPILOT_MARKET_FRESHNESS_MIN_SYMBOLS 必须是正整数。',
);

if (value('QUANTPILOT_ENABLE_INTERNAL_TOKEN_API') && flag('QUANTPILOT_ENABLE_INTERNAL_TOKEN_API')) {
  secureSecret('QUANTPILOT_INTERNAL_API_TOKEN');
}
if (flag('GRAFANA_ANONYMOUS_ENABLED', false)) {
  errors.push('生产环境必须关闭 Grafana 匿名访问。');
}
if (value('GRAFANA_ADMIN_PASSWORD') && PLACEHOLDER_PATTERN.test(value('GRAFANA_ADMIN_PASSWORD'))) {
  errors.push('GRAFANA_ADMIN_PASSWORD 不能使用开发默认值或占位值。');
}

if (requireBootstrap) {
  requireValue('QUANTPILOT_AUTH_ADMIN_EMAIL', (configured) => configured.includes('@') && !configured.endsWith('@quantpilot.local'), '首次生产 bootstrap 必须配置正式管理员邮箱。');
  secureSecret('QUANTPILOT_AUTH_ADMIN_PASSWORD', 12);
} else if (value('QUANTPILOT_AUTH_ADMIN_PASSWORD')) {
  warnings.push('管理员初始化完成后应从长期运行环境移除 QUANTPILOT_AUTH_ADMIN_PASSWORD。');
}

for (const warning of warnings) console.warn(`[production-readiness] WARN ${warning}`);
for (const error of errors) console.error(`[production-readiness] FAIL ${error}`);

if (errors.length > 0) {
  console.error(`[production-readiness] blocked: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}

console.log(`[production-readiness] ready: 0 errors, ${warnings.length} warning(s)`);
