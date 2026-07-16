#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/evals/prepare-shadow-replay.js'), {
  interopDefault: true,
});
const { attestProductionReplayCase, buildProductionReplayCase } = jiti('../../src/lib/eval/shadow-replay.ts');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const input = argument('--input');
const output = argument('--output');
if (!input || !output) throw new Error('用法：npm run eval:prepare-shadow -- --input <json/jsonl> --output <外部 cases.json>');
const inputPath = path.resolve(input);
const outputPath = path.resolve(output);
const hashKey = String(process.env.QUANTPILOT_REPLAY_HASH_KEY || '');
if (hashKey.length < 16) throw new Error('必须设置至少 16 字符的 QUANTPILOT_REPLAY_HASH_KEY');
const content = fs.readFileSync(inputPath, 'utf8');
let records;
if (inputPath.endsWith('.jsonl')) {
  records = content.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
} else {
  records = JSON.parse(content);
}
if (!Array.isArray(records)) throw new Error('shadow 输入必须是 JSON 数组或 JSONL');
const byPromptHash = new Map();
for (const record of records) {
  const prepared = buildProductionReplayCase(record, { hashKey });
  const attestation = attestProductionReplayCase(prepared);
  if (!attestation.passed) throw new Error(attestation.problems.join('；'));
  byPromptHash.set(prepared.privacy.sourcePromptHmacSha256, prepared);
}
const cases = [...byPromptHash.values()];
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(cases, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`[eval-shadow] prepared=${cases.length}/${records.length} output=${outputPath}`);
console.log('[eval-shadow] 输出包含脱敏 prompt 和 hash，不包含 user/project/request/session 身份。');
