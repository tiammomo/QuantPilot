#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const OFFICIAL_BASE_URL = 'https://api.deepseek.com';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`✅ ${message}`);
}

console.log('\n🔒 MoAgent AI 接入边界检查：仅 DeepSeek V4 Flash 官方直连\n');

const envExample = read('.env.example');
if (!/^DEEPSEEK_API_KEY=/m.test(envExample)) {
  fail('.env.example 必须声明 DEEPSEEK_API_KEY');
} else {
  pass('唯一公开模型凭据为 DEEPSEEK_API_KEY');
}

for (const key of [
  'QUANTPILOT_LLM_AGENT_ENABLED',
  'QUANTPILOT_LLM_QUERY_REWRITE_ENABLED',
  'QUANTPILOT_QUERY_REWRITE_LLM_MODE',
  'QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS',
  'QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES',
]) {
  if (!new RegExp(`^${key}=`, 'm').test(envExample)) {
    fail(`.env.example 必须声明 LLM 配置：${key}`);
  }
}

const llmConfig = JSON.parse(read('config/llm.json'));
const llmProfile = llmConfig?.profiles?.[llmConfig?.defaultProfileId];
if (
  llmConfig?.schemaVersion !== 1 ||
  llmConfig?.defaultProfileId !== DEEPSEEK_MODEL ||
  llmProfile?.provider !== 'deepseek' ||
  llmProfile?.model !== DEEPSEEK_MODEL ||
  llmProfile?.baseUrl !== OFFICIAL_BASE_URL ||
  llmProfile?.credentialEnv !== 'DEEPSEEK_API_KEY' ||
  typeof llmProfile?.agent?.enabled !== 'boolean' ||
  !['off', 'auto', 'always'].includes(llmProfile?.queryRewrite?.mode)
) {
  fail('config/llm.json 必须提供完整且锁定官方边界的 LLM profile');
} else {
  pass('中央 LLM profile、Agent 与 Query Rewrite 配置完整');
}

for (const key of [
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_OPENAI_API_KEY',
  'MINIMAX_API_KEY',
]) {
  if (envExample.includes(key)) fail(`.env.example 不得暴露旧供应商或中转配置：${key}`);
}

const modelRegistry = read('src/lib/constants/models.ts');
if (!modelRegistry.includes(`DEEPSEEK_MODEL_ID = '${DEEPSEEK_MODEL}'`)) {
  fail(`模型注册表必须锁定为 ${DEEPSEEK_MODEL}`);
} else if (!modelRegistry.includes(`DEEPSEEK_OFFICIAL_BASE_URL = '${OFFICIAL_BASE_URL}'`)) {
  fail(`模型注册表必须锁定 DeepSeek 官方地址 ${OFFICIAL_BASE_URL}`);
} else {
  pass(`模型与地址已锁定：${DEEPSEEK_MODEL} · ${OFFICIAL_BASE_URL}`);
}

const requiredRuntimeFiles = [
  'src/lib/agent/types.ts',
  'src/lib/agent/core/run-engine.ts',
  'src/lib/agent/providers/deepseek.ts',
  'src/lib/agent/tools/index.ts',
  'src/lib/agent/skills/compiler.ts',
  'src/lib/services/cli/moagent.ts',
];
for (const file of requiredRuntimeFiles) {
  if (!fs.existsSync(path.join(ROOT, file))) fail(`MoAgent 运行时缺少：${file}`);
}

const removedRuntimeFiles = [
  'src/lib/services/cli/claude.ts',
  'src/lib/services/quant-image-mcp.ts',
];
for (const file of removedRuntimeFiles) {
  if (fs.existsSync(path.join(ROOT, file))) fail(`旧 Agent 运行时仍然存在：${file}`);
}

const packageJson = read('package.json');
const nextConfig = read('next.config.js');
const sdkPackageName = ['@anthropic-ai', 'claude-agent-sdk'].join('/');
if (packageJson.includes(sdkPackageName) || nextConfig.includes(sdkPackageName)) {
  fail('依赖或 Next.js 配置中仍存在外部 Agent SDK');
} else {
  pass('外部 Agent SDK 已从依赖和构建配置移除');
}

const provider = read('src/lib/agent/providers/deepseek.ts');
if (!provider.includes('/chat/completions') || !provider.includes('globalThis.fetch')) {
  fail('DeepSeek Provider 必须由 MoAgent 直接调用 /chat/completions');
} else if (provider.includes('/anthropic')) {
  fail('DeepSeek Provider 不得继续使用 Anthropic 兼容端点');
} else {
  pass('MoAgent 通过 OpenAI-compatible SSE 直连 DeepSeek');
}

const runtime = read('src/lib/services/cli/moagent.ts');
for (const input of [
  'process.env.ANTHROPIC_BASE_URL',
  'process.env.OPENAI_API_KEY',
  'process.env.CODEX_OPENAI_API_KEY',
  'process.env.MINIMAX_API_KEY',
  'process.env.DEEPSEEK_BASE_URL',
]) {
  if (runtime.includes(input)) fail(`MoAgent 不得读取旧供应商或自定义中转配置：${input}`);
}
if (!runtime.includes('process.env.DEEPSEEK_API_KEY')) {
  fail('MoAgent 必须只读取 DEEPSEEK_API_KEY');
} else if (!runtime.includes('baseUrl: DEEPSEEK_OFFICIAL_BASE_URL')) {
  fail('MoAgent 必须使用锁定的 DeepSeek 官方 Base URL');
} else {
  pass('MoAgent 凭据和 Provider 地址边界正确');
}

const route = read('src/app/api/chat/[project_id]/act/route.ts');
if (!route.includes('import("@/lib/services/cli/moagent")')) {
  fail('聊天执行链路尚未切换至 MoAgent');
} else if (route.includes('activeClaudeSessionId')) {
  fail('聊天执行链路仍依赖供应商 session id');
} else {
  pass('QuantPilot 主执行链路已切换至 MoAgent');
}

if (!process.exitCode) {
  pass('MoAgent 单供应商边界完整');
  console.log('');
}
