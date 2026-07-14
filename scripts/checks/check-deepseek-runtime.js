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

function bundledRuntimeExists() {
  const scopeDir = path.join(process.cwd(), 'node_modules', '@anthropic-ai');
  try {
    return fs.readdirSync(scopeDir).some((name) => name.startsWith('claude-agent-sdk-'));
  } catch {
    return false;
  }
}

console.log('\n🔍 DeepSeek V4 Flash 官方直连检查\n');
console.log(`模型：deepseek-v4-flash`);
console.log(`官方接口：https://api.deepseek.com/anthropic`);

if (!bundledRuntimeExists()) {
  console.error('❌ 本地 Agent 执行引擎缺失，请运行 npm install。');
  process.exit(1);
}
console.log('✅ 本地 Agent 执行引擎已安装');

if (!readEnvValue('DEEPSEEK_API_KEY')) {
  console.error('❌ DEEPSEEK_API_KEY 未配置，请写入 .env.local。');
  process.exit(1);
}
console.log('✅ DEEPSEEK_API_KEY 已配置');
console.log('✅ 项目不接受自定义 Base URL、备用模型或第三方中转配置\n');
