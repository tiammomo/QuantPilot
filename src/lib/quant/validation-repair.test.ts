import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildQuantValidationRepairInstruction,
  buildQuantValidationRepairPlan,
  repairQuantPlatformOwnedArtifacts,
  type QuantValidationReport,
} from './validation';

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

function failedReport(projectId = 'project-validation'): QuantValidationReport {
  const timestamp = '2026-07-14T00:00:00.000Z';
  return {
    schemaVersion: 1,
    projectId,
    reportPath: '.quantpilot/validation.json',
    status: 'failed',
    passed: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    checks: [
      {
        id: 'artifact_contracts',
        name: '产物 Schema 契约',
        status: 'failed',
        summary: '平台结构产物不符合契约。',
        details: 'run_plan_contract: expectedArtifacts 缺失，run_plan 与模板不一致。',
      },
      {
        id: 'final_data_file',
        name: '最终数据文件',
        status: 'failed',
        summary: 'final 数据结构不完整。',
      },
    ],
  };
}

describe('validation repair ownership', () => {
  it('keeps every .quantpilot artifact platform-owned in Agent repair instructions', () => {
    const report = failedReport();
    const plan = buildQuantValidationRepairPlan(report);
    const instruction = buildQuantValidationRepairInstruction(report, {
      originalInstruction: '比较贵州茅台 600519 与宁德时代 300750 的表现',
    });

    expect(plan.steps.flatMap((step) => step.actions).join('\n')).not.toMatch(
      /修复 \.quantpilot|修改 \.quantpilot|把 \.quantpilot\/run_plan/,
    );
    expect(instruction).toContain('整个 `.quantpilot/**`');
    expect(instruction).toContain('结构修复和重新生成由平台负责');
    expect(instruction).toContain('app/**、data_file/final/** 和 evidence/**');
    expect(instruction).toContain('你不得修改它');
  });

  it('rebuilds an invalid run plan with the parent request before Agent repair', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-platform-repair-'));
    temporaryProjects.push(projectPath);
    const result = await repairQuantPlatformOwnedArtifacts({
      projectPath,
      requestId: 'parent-request',
      originalInstruction: '比较贵州茅台 600519 与宁德时代 300750 的表现并生成看板',
      report: failedReport(),
    });
    const plan = JSON.parse(
      await fs.readFile(path.join(projectPath, '.quantpilot', 'run_plan.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(result.runPlanRebuilt).toBe(true);
    expect(plan.runId).toBe('parent-request');
    expect(plan.capabilityId).toBe('asset_comparison');
  });
});
