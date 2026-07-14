#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const OFFICIAL_BASE_URL = 'https://api.deepseek.com/anthropic';

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

console.log('\n🔒 AI 接入边界检查：仅 DeepSeek V4 Flash 官方直连\n');

const envExample = read('.env.example');
if (!/^DEEPSEEK_API_KEY=/m.test(envExample)) {
  fail('.env.example 必须声明 DEEPSEEK_API_KEY');
} else {
  pass('唯一公开 API 凭据为 DEEPSEEK_API_KEY');
}

const forbiddenEnvKeys = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'CODEX_OPENAI_API_KEY',
  'MINIMAX_API_KEY',
  'CLAUDE_CODE_MODEL_',
];
for (const key of forbiddenEnvKeys) {
  if (envExample.includes(key)) fail(`.env.example 不得暴露旧供应商或中转配置：${key}`);
}

const modelRegistry = read('src/lib/constants/models.ts');
if (!modelRegistry.includes(`DEEPSEEK_MODEL_ID = '${DEEPSEEK_MODEL}'`)) {
  fail(`模型注册表必须锁定为 ${DEEPSEEK_MODEL}`);
} else if (!modelRegistry.includes(OFFICIAL_BASE_URL)) {
  fail(`模型注册表必须锁定 DeepSeek 官方地址 ${OFFICIAL_BASE_URL}`);
} else {
  pass(`模型与地址已锁定：${DEEPSEEK_MODEL} · ${OFFICIAL_BASE_URL}`);
}

const adapterDirectory = path.join(ROOT, 'src/lib/services/cli');
const adapters = fs.readdirSync(adapterDirectory)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
  .sort();
if (adapters.length !== 1 || adapters[0] !== 'claude.ts') {
  fail(`运行时适配器目录只允许保留内部执行引擎 claude.ts，当前为：${adapters.join(', ') || '空'}`);
} else {
  pass('其他 CLI / 模型供应商适配器已移除');
}

const runtime = read('src/lib/services/cli/claude.ts');
const forbiddenRuntimeInputs = [
  'process.env.ANTHROPIC_BASE_URL',
  'process.env.OPENAI_API_KEY',
  'process.env.CODEX_OPENAI_API_KEY',
  'process.env.MINIMAX_API_KEY',
];
for (const input of forbiddenRuntimeInputs) {
  if (runtime.includes(input)) fail(`运行时不得读取旧供应商或中转配置：${input}`);
}
if (!runtime.includes('process.env.DEEPSEEK_API_KEY')) {
  fail('运行时必须只读取 DEEPSEEK_API_KEY');
} else if (!runtime.includes('const runtimeEnv: Record<string, string | undefined> = {}')) {
  fail('运行时必须从空白白名单构造执行环境，禁止继承宿主供应商凭据');
} else if (!runtime.includes('CLAUDE_CODE_SUBAGENT_MODEL: runtimeModel')) {
  fail('子 Agent 模型也必须锁定为 DeepSeek V4 Flash');
} else {
  pass('主 Agent、子 Agent 与凭据入口均已锁定到 DeepSeek');
}

const removedAdapters = ['codex.ts', 'codex-config.ts', 'cursor.ts', 'qwen.ts', 'glm.ts'];
const removedAssets = ['claude.png', 'cursor.png', 'gemini.png', 'glm.svg', 'oai.png', 'qwen.png'];
for (const name of removedAdapters) {
  if (fs.existsSync(path.join(adapterDirectory, name))) fail(`旧适配器仍然存在：${name}`);
}
for (const name of removedAssets) {
  if (fs.existsSync(path.join(ROOT, 'public', name))) fail(`旧供应商品牌资源仍然存在：public/${name}`);
}

if (!process.exitCode) {
  pass('DeepSeek 单供应商边界完整');
  console.log('');
}
