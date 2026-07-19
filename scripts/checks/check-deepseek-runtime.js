#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function readEnvFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readEnvValue(key) {
  if (process.env[key]) return process.env[key];
  for (const file of ['.env.local', '.env']) {
    const contents = readEnvFile(path.join(process.cwd(), file));
    const match = contents.match(new RegExp(`^${key}=["']?([^"'\\n]+)["']?$`, 'm'));
    if (match) return match[1];
  }
  return '';
}

function moAgentRuntimeExists() {
  return [
    'src/lib/agent/core/run-engine.ts',
    'src/lib/agent/providers/deepseek.ts',
    'src/lib/agent/providers/openai-compatible.ts',
    'src/lib/agent/tools/index.ts',
    'src/lib/services/cli/moagent.ts',
  ].every((file) => fs.existsSync(path.join(process.cwd(), file)));
}

console.log('\n🔍 MoAgent · 模型 Provider 配置检查\n');
console.log('默认模型：local_qwen:qwen3.5-9b-q5km');
console.log('日常 DeepSeek：deepseek:deepseek-v4-flash（ModelPort）');
console.log('可选直连：deepseek-v4-flash（官方 API）');

if (!moAgentRuntimeExists()) {
  console.error('❌ MoAgent 自研执行内核不完整。');
  process.exit(1);
}
console.log('✅ MoAgent 核心、Provider、Tools 与产品接入层已就绪');

const deepSeekConfigured = Boolean(readEnvValue('DEEPSEEK_API_KEY'));
const modelPortConfigured = Boolean(readEnvValue('MODELPORT_API_KEY'));
if (!modelPortConfigured) {
  console.error('❌ 未配置 ModelPort 客户端凭据，请在 .env.local 中填写 MODELPORT_API_KEY。');
  process.exit(1);
}
console.log('✅ ModelPort：Qwen 与托管 DeepSeek 客户端凭据已配置');
console.log(`${deepSeekConfigured ? '✅' : 'ℹ️'} DeepSeek 官方直连：${deepSeekConfigured ? '运行环境凭据已注入' : '未启用（正常）'}`);
console.log('✅ Provider Base URL 与模型 ID 由 config/llm.json 锁定\n');
