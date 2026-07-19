#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const MODELPORT_DEEPSEEK_MODEL = 'deepseek:deepseek-v4-flash';
const OFFICIAL_BASE_URL = 'https://api.deepseek.com';
const LOCAL_MODEL = 'local_qwen:qwen3.5-9b-q5km';
const LOCAL_BASE_URL = 'http://127.0.0.1:38082/v1';

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

console.log('\n🔒 MoAgent AI 接入边界检查：ModelPort 日常路由 + 可选 DeepSeek 官方直连\n');

const envExample = read('.env.example');
if (!/^MODELPORT_API_KEY=/m.test(envExample)) {
  fail('.env.example 必须声明 MODELPORT_API_KEY');
} else if (/^(?:DEEPSEEK_API_KEY|LOCAL_OPENAI_API_KEY)=/m.test(envExample)) {
  fail('.env.example 不得鼓励在 QuantPilot 本地保存上游 DeepSeek 或旧本地 Provider Key');
} else {
  pass('QuantPilot 只声明 ModelPort 客户端凭据；上游 DeepSeek Key 留在 ModelPort');
}

for (const key of [
  'QUANTPILOT_LLM_AGENT_ENABLED',
  'QUANTPILOT_LLM_QUERY_REWRITE_ENABLED',
  'QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS',
  'QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES',
]) {
  if (!new RegExp(`^${key}=`, 'm').test(envExample)) {
    fail(`.env.example 必须声明 LLM 配置：${key}`);
  }
}

const llmConfig = JSON.parse(read('config/llm.json'));
const deepSeekProfile = llmConfig?.profiles?.[DEEPSEEK_MODEL];
const modelPortDeepSeekProfile = llmConfig?.profiles?.[MODELPORT_DEEPSEEK_MODEL];
const localProfile = llmConfig?.profiles?.[LOCAL_MODEL];
if (
  llmConfig?.schemaVersion !== 1 ||
  llmConfig?.defaultProfileId !== LOCAL_MODEL ||
  deepSeekProfile?.provider !== 'deepseek' ||
  deepSeekProfile?.model !== DEEPSEEK_MODEL ||
  deepSeekProfile?.baseUrl !== OFFICIAL_BASE_URL ||
  deepSeekProfile?.credentialEnv !== 'DEEPSEEK_API_KEY' ||
  modelPortDeepSeekProfile?.provider !== 'openai' ||
  modelPortDeepSeekProfile?.model !== MODELPORT_DEEPSEEK_MODEL ||
  modelPortDeepSeekProfile?.baseUrl !== LOCAL_BASE_URL ||
  modelPortDeepSeekProfile?.credentialEnv !== 'MODELPORT_API_KEY' ||
  localProfile?.provider !== 'openai' ||
  localProfile?.model !== LOCAL_MODEL ||
  localProfile?.baseUrl !== LOCAL_BASE_URL ||
  localProfile?.credentialEnv !== 'MODELPORT_API_KEY' ||
  typeof deepSeekProfile?.agent?.enabled !== 'boolean' ||
  typeof modelPortDeepSeekProfile?.agent?.enabled !== 'boolean' ||
  typeof localProfile?.agent?.enabled !== 'boolean' ||
  deepSeekProfile?.queryRewrite?.enabled !== true ||
  modelPortDeepSeekProfile?.queryRewrite?.enabled !== true ||
  localProfile?.queryRewrite?.enabled !== true ||
  deepSeekProfile?.queryRewrite?.timeoutMs !== 12_000 ||
  modelPortDeepSeekProfile?.queryRewrite?.timeoutMs !== 12_000 ||
  localProfile?.queryRewrite?.timeoutMs !== 12_000
) {
  fail('config/llm.json 必须提供 Qwen、ModelPort DeepSeek 与官方直连三个锁定 profiles');
} else {
  pass('中央 LLM profiles、Qwen 默认值、ModelPort DeepSeek 与官方直连配置完整');
}

for (const key of [
  'ANTHROPIC_BASE_URL',
  'LOCAL_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_OPENAI_API_KEY',
  'MINIMAX_API_KEY',
]) {
  if (new RegExp(`^${key}=`, 'm').test(envExample)) {
    fail(`.env.example 不得暴露旧供应商或中转配置：${key}`);
  }
}

const modelRegistry = read('src/lib/constants/models.ts');
if (!modelRegistry.includes(`DEEPSEEK_MODEL_ID = '${DEEPSEEK_MODEL}'`)) {
  fail(`模型注册表必须锁定为 ${DEEPSEEK_MODEL}`);
} else if (!modelRegistry.includes(`DEEPSEEK_OFFICIAL_BASE_URL = '${OFFICIAL_BASE_URL}'`)) {
  fail(`模型注册表必须锁定 DeepSeek 官方地址 ${OFFICIAL_BASE_URL}`);
} else if (!modelRegistry.includes(`LOCAL_QWEN_MODEL_ID = '${LOCAL_MODEL}'`)) {
  fail(`模型注册表必须包含本地模型 ${LOCAL_MODEL}`);
} else if (!modelRegistry.includes(`LOCAL_OPENAI_BASE_URL = '${LOCAL_BASE_URL}'`)) {
  fail(`模型注册表必须锁定本地地址 ${LOCAL_BASE_URL}`);
} else if (!modelRegistry.includes(`MODELPORT_DEEPSEEK_MODEL_ID = '${MODELPORT_DEEPSEEK_MODEL}'`)) {
  fail(`模型注册表必须包含 ModelPort DeepSeek 模型 ${MODELPORT_DEEPSEEK_MODEL}`);
} else if (!modelRegistry.includes('MOAGENT_DEFAULT_MODEL: MoAgentModelId = LOCAL_QWEN_MODEL_ID')) {
  fail(`MoAgent 默认模型必须为 ${LOCAL_MODEL}`);
} else {
  pass('本地 Qwen 默认模型、ModelPort DeepSeek 与官方直连地址均已锁定');
}

const requiredRuntimeFiles = [
  'src/lib/agent/types.ts',
  'src/lib/agent/core/run-engine.ts',
  'src/lib/agent/providers/deepseek.ts',
  'src/lib/agent/providers/openai-compatible.ts',
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
const openAICompatibleProvider = read('src/lib/agent/providers/openai-compatible.ts');
if (!provider.includes('/chat/completions') || !provider.includes('globalThis.fetch')) {
  fail('DeepSeek Provider 必须由 MoAgent 直接调用 /chat/completions');
} else if (provider.includes('/anthropic')) {
  fail('DeepSeek Provider 不得继续使用 Anthropic 兼容端点');
} else {
  pass('MoAgent 通过 OpenAI-compatible SSE 直连 DeepSeek');
}
if (
  !openAICompatibleProvider.includes("reasoningWireFormat: 'none'") ||
  !openAICompatibleProvider.includes('OpenAICompatibleProvider')
) {
  fail('本地 OpenAI-compatible Provider 必须复用受控 SSE 边界并禁用 DeepSeek 私有字段');
} else {
  pass('本地 OpenAI-compatible Provider 已禁用 DeepSeek 私有 thinking wire format');
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
if (!runtime.includes('process.env[llmConfig.credentialEnv]')) {
  fail('MoAgent 必须按锁定 profile 读取对应凭据');
} else if (!runtime.includes('baseUrl: llmConfig.baseUrl')) {
  fail('MoAgent 必须按锁定 profile 使用 Provider Base URL');
} else if (!runtime.includes("llmConfig.provider === 'deepseek'")) {
  fail('MoAgent 必须显式分派 DeepSeek 与 OpenAI-compatible Provider');
} else {
  pass('MoAgent 多 Provider 凭据和地址边界正确');
}

const route = read('src/app/api/chat/[project_id]/act/route.ts');
if (!route.includes('import("@/lib/services/cli/moagent")')) {
  fail('聊天执行链路尚未切换至 MoAgent');
} else if (route.includes('activeClaudeSessionId')) {
  fail('聊天执行链路仍依赖供应商 session id');
} else {
  pass('QuantPilot 主执行链路已切换至 MoAgent');
}

const queryRewriteRoute = read('src/app/api/quant/query/rewrite/route.ts');
const queryRewriteAdapter = read('src/lib/quant/query-rewrite-llm.ts');
const queryRewriteRuntime = read('src/lib/quant/query-rewrite.ts');
const queryRewriteWorkspace = read('src/lib/quant/workspace.ts');
const queryRewritePrefetch = read('src/lib/quant/data-prefetch.ts');
const chatInput = read('src/components/chat/ChatInput.tsx');
const homePage = read('src/app/page.tsx');
if (
  queryRewriteRoute.includes("action: purpose === 'execution'") ||
  queryRewriteRoute.includes("action: 'quant.data.read'")
) {
  fail('Query Rewrite API 的所有 purpose 都必须走受控 LLM 权限与执行路径');
} else if (
  queryRewriteAdapter.includes('deterministicDraft') ||
  queryRewriteAdapter.includes('input.deterministic') ||
  queryRewriteRoute.includes('allowLlm') ||
  queryRewriteRuntime.includes('extractQuantQueryTargetCandidates') ||
  queryRewriteRuntime.includes('deterministic_fallback') ||
  queryRewriteWorkspace.includes('inferQuantSymbolsFromText') ||
  queryRewritePrefetch.includes('inferQuantSymbolsFromText(plan.question)')
) {
  fail('正常 Query Rewrite 模型路径不得注入或依赖关键词/正则草稿');
} else if (
  chatInput.includes("purpose: 'preview'") ||
  chatInput.includes('inferSymbolSearchQuery') ||
  chatInput.includes('inferQuestionTimeRange') ||
  chatInput.includes('inferQuestionFocus') ||
  homePage.includes('inferSymbolSearchQuery') ||
  homePage.includes('inferQuestionTimeRange') ||
  homePage.includes('inferQuestionFocus')
) {
  fail('输入界面不得把关键词预判展示为 Query Rewrite 结果');
} else {
  pass('Query Rewrite 正常路径与输入界面均为 LLM-first');
}

if (!process.exitCode) {
  pass('MoAgent 双 Provider 边界完整');
  console.log('');
}
