import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readQuantGenerationState,
  startQuantGenerationRun,
  updateQuantGenerationStep,
} from '@/lib/quant/generation-state';
import type { QuantValidationReport } from '@/lib/quant/validation';
import { failBenchmarkGenerationRun, runBenchmarkRepairLoop } from './benchmark-repair';

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

function report(passed: boolean): QuantValidationReport {
  const timestamp = '2026-07-14T00:00:00.000Z';
  return {
    schemaVersion: 1,
    projectId: 'benchmark-project',
    reportPath: '.quantpilot/validation.json',
    status: passed ? 'passed' : 'failed',
    passed,
    createdAt: timestamp,
    updatedAt: timestamp,
    checks: [
      {
        id: 'next_build',
        name: 'Next.js 构建',
        status: passed ? 'passed' : 'failed',
        summary: passed ? '构建通过。' : '构建失败。',
      },
    ],
  };
}

async function setupRun(maxRepairAttempts = 2) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-benchmark-repair-'));
  temporaryProjects.push(projectPath);
  const identifiers = {
    projectPath,
    projectId: 'benchmark-project',
    parentRequestId: 'benchmark-project-run',
  };
  await startQuantGenerationRun({
    projectPath,
    projectId: identifiers.projectId,
    requestId: identifiers.parentRequestId,
    instruction: '生成看板',
    maxRepairAttempts,
  });
  return identifiers;
}

describe('benchmark repair state machine', () => {
  it('executes fail -> repair -> revalidate with the parent request throughout', async () => {
    const identifiers = await setupRun();
    const applyRepair = vi.fn(async () => undefined);
    const validate = vi.fn(async () => report(true));

    const result = await runBenchmarkRepairLoop({
      ...identifiers,
      originalInstruction: '生成看板',
      initialValidation: report(false),
      preparePlatformArtifacts: async () => ({ runPlanRebuilt: false }),
      applyRepair,
      validate,
    });

    expect(result.validation.passed).toBe(true);
    expect(result.repairAttempts).toBe(1);
    expect(applyRepair).toHaveBeenCalledWith(expect.objectContaining({
      parentRequestId: identifiers.parentRequestId,
      repairRequestId: `${identifiers.parentRequestId}-validation-repair-1`,
    }));
    expect(validate).toHaveBeenCalledWith(identifiers.parentRequestId);
    expect(await readQuantGenerationState(identifiers.projectPath)).toMatchObject({
      requestId: identifiers.parentRequestId,
      activeStep: 'final_validation',
      repairAttemptCount: 1,
      steps: expect.arrayContaining([
        expect.objectContaining({ id: 'final_validation', status: 'success' }),
      ]),
    });
  });

  it('terminalizes the parent state when applying a repair throws', async () => {
    const identifiers = await setupRun();

    await expect(runBenchmarkRepairLoop({
      ...identifiers,
      originalInstruction: '生成看板',
      initialValidation: report(false),
      preparePlatformArtifacts: async () => ({ runPlanRebuilt: false }),
      applyRepair: async () => {
        throw new Error('repair exploded');
      },
      validate: async () => report(true),
    })).rejects.toThrow('repair exploded');

    expect(await readQuantGenerationState(identifiers.projectPath)).toMatchObject({
      requestId: identifiers.parentRequestId,
      status: 'failed',
      activeStep: 'repair',
      error: { step: 'repair', message: 'repair exploded' },
    });
  });

  it('closes a running initialization stage when the benchmark escapes', async () => {
    const identifiers = await setupRun();
    await updateQuantGenerationStep({
      projectPath: identifiers.projectPath,
      projectId: identifiers.projectId,
      requestId: identifiers.parentRequestId,
      stepId: 'agent_execution',
      status: 'running',
      summary: 'Agent starting',
    });

    await failBenchmarkGenerationRun({
      ...identifiers,
      error: new Error('initialization failed'),
    });

    expect(await readQuantGenerationState(identifiers.projectPath)).toMatchObject({
      requestId: identifiers.parentRequestId,
      status: 'failed',
      activeStep: 'agent_execution',
      completedAt: expect.any(String),
      error: { step: 'agent_execution', message: 'initialization failed' },
    });
  });
});
