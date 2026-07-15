import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildQuantValidationRepairInstruction,
  buildQuantValidationRepairPlan,
  quantValidationRepairWritableGlobs,
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

function visualOnlyFailedReport(projectId = 'project-visual-validation'): QuantValidationReport {
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
        id: 'visual_presentation',
        name: '视觉呈现',
        status: 'failed',
        summary: '移动端首屏没有露出核心图表。',
        details: 'viewport 390x844，主图被过高的摘要区推到首屏之外。',
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
    const writableGlobs = quantValidationRepairWritableGlobs(report);

    expect(plan.steps.flatMap((step) => step.actions).join('\n')).not.toMatch(
      /修复 \.quantpilot|修改 \.quantpilot|把 \.quantpilot\/run_plan/,
    );
    expect(instruction).toContain('整个 `.quantpilot/**`');
    expect(instruction).toContain('结构修复和重新生成由平台负责');
    expect(instruction).toContain('data_file/final/** 和 evidence/**');
    expect(instruction).not.toContain('唯一可写范围：app/**');
    expect(instruction).toContain('你不得修改它');
    expect(instruction).toContain('构建、预览与自动验证由 QuantPilot 平台统一执行');
    expect(instruction).toContain('submit_result');
    expect(writableGlobs).toEqual(['data_file/final/**', 'evidence/**']);
  });

  it('keeps visual-only repair scoped to app sources and platform-owned validation', () => {
    const report = visualOnlyFailedReport();
    const plan = buildQuantValidationRepairPlan(report);
    const instruction = buildQuantValidationRepairInstruction(report);
    const actions = plan.steps.flatMap((step) => step.actions).join('\n');
    const writableGlobs = quantValidationRepairWritableGlobs(report);

    expect(instruction).toContain('失败 ID：visual_presentation');
    expect(instruction).toContain('唯一可写范围：app/**');
    expect(instruction).toContain('.quantpilot/visual-validation.json（仅失败 viewport 和其截图路径）');
    expect(instruction).toContain('visual_presentation：失败 viewport 的首屏主体可见');
    expect(instruction).toContain('typed tools');
    expect(instruction).not.toContain('data_file/final/**');
    expect(instruction).not.toContain('evidence/**');
    expect(instruction).not.toContain('npm run build');
    expect(instruction).not.toContain('app/api/market/[...path]/route.ts');
    expect(instruction).not.toContain('必须先读取');
    expect(actions).not.toContain('market/[...path]');
    expect(writableGlobs).toEqual(['app/**']);
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
