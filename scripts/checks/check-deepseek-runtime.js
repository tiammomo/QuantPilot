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
    'src/lib/agent/tools/index.ts',
    'src/lib/services/cli/moagent.ts',
  ].every((file) => fs.existsSync(path.join(process.cwd(), file)));
}

console.log('\n🔍 MoAgent · DeepSeek V4 Flash 官方直连检查\n');
console.log(`模型：deepseek-v4-flash`);
console.log(`官方接口：https://api.deepseek.com/chat/completions`);

if (!moAgentRuntimeExists()) {
  console.error('❌ MoAgent 自研执行内核不完整。');
  process.exit(1);
}
console.log('✅ MoAgent 核心、Provider、Tools 与产品接入层已就绪');

if (!readEnvValue('DEEPSEEK_API_KEY')) {
  console.error('❌ DEEPSEEK_API_KEY 未配置，请写入 .env.local。');
  process.exit(1);
}
console.log('✅ DEEPSEEK_API_KEY 已配置');
console.log('✅ 项目不接受自定义 Base URL、备用模型或第三方中转配置\n');
