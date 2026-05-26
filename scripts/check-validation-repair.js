#!/usr/bin/env node

require('tsconfig-paths/register');

const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/check-validation-repair.js'), {
  interopDefault: true,
});

const {
  buildQuantValidationRepairInstruction,
  buildQuantValidationRepairPlan,
} = jiti('../lib/quant/validation.ts');

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

const report = {
  schemaVersion: 1,
  projectId: 'validation-repair-smoke',
  status: 'failed',
  passed: false,
  reportPath: '.quantpilot/validation.json',
  createdAt: '2026-05-25T00:00:00.000Z',
  updatedAt: '2026-05-25T00:00:01.000Z',
  checks: [
    {
      id: 'artifact_policy',
      name: '生成产物策略',
      status: 'failed',
      summary: '检测到外部 CDN 与 mock 数据。',
      details: 'app/page.tsx 包含 https://cdn.jsdelivr.net 与 MOCK_DATA。',
    },
    {
      id: 'chart_presence',
      name: '金融图表存在性',
      status: 'failed',
      summary: '未检测到 K 线、成交量或指标图表。',
    },
  ],
};

const failures = [];
const plan = buildQuantValidationRepairPlan(report);
const instruction = buildQuantValidationRepairInstruction(report, {
  originalInstruction: '分析贵州茅台最近财务和 K 线，生成可视化看板。',
});

assertCondition(plan.status === 'needed', 'repair plan 状态应为 needed。', failures);
assertCondition(plan.repairPlanPath === '.quantpilot/validation-repair-plan.json', 'repair plan 路径不正确。', failures);
assertCondition(plan.steps.length === 2, `repair plan 应包含 2 个步骤，实际为 ${plan.steps.length}。`, failures);
assertCondition(plan.steps[0]?.checkId === 'artifact_policy', '第一个失败项应保留 artifact_policy。', failures);
assertCondition(
  plan.steps[0]?.actions?.some((action) => action.includes('移除外部 CDN')),
  'artifact_policy 修复动作应要求移除外部 CDN。',
  failures
);
assertCondition(
  plan.steps[0]?.actions?.some((action) => action.includes('MOCK_DATA')),
  'artifact_policy 修复动作应要求移除 mock/static 产物。',
  failures
);
assertCondition(
  plan.steps[1]?.actions?.some((action) => action.includes('K 线')),
  'chart_presence 修复动作应要求补齐 K 线等金融图表。',
  failures
);
assertCondition(
  instruction.includes('.quantpilot/validation-repair-plan.json'),
  '修复提示词应包含结构化修复计划路径。',
  failures
);
assertCondition(instruction.includes('移除外部 CDN'), '修复提示词应包含外部 CDN 禁用规则。', failures);
assertCondition(instruction.includes('金融图表'), '修复提示词应包含金融图表修复要求。', failures);

if (failures.length > 0) {
  console.error('[validation-repair] failed');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[validation-repair] ok');
