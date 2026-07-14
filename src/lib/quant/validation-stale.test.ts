import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessQuantValidationReportFreshness,
  readQuantValidationReport,
  type QuantValidationReport,
} from './validation';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'quantpilot-validation-stale-'),
  );
  temporaryProjects.push(projectPath);
  await fs.mkdir(path.join(projectPath, '.quantpilot'), { recursive: true });
  return projectPath;
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validationReport(
  status: 'passed' | 'failed',
  runId = 'run-current',
): QuantValidationReport {
  const timestamp = '2026-07-14T00:00:00.000Z';
  return {
    schemaVersion: 1,
    runId,
    projectId: 'project-stale-report',
    reportPath: '.quantpilot/validation.json',
    status,
    passed: status === 'passed',
    checks: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

describe('validation report freshness', () => {
  it.each(['passed', 'failed'] as const)(
    'marks a %s report stale when a critical artifact is newer',
    async (status) => {
      const projectPath = await createProject();
      const reportPath = path.join(
        projectPath,
        '.quantpilot',
        'validation.json',
      );
      const artifactPath = path.join(
        projectPath,
        'data_file',
        'final',
        'dashboard-data.json',
      );
      await writeJson(reportPath, validationReport(status));
      await writeJson(artifactPath, { symbol: '600111' });
      await fs.utimes(
        reportPath,
        new Date('2026-07-14T00:00:00.000Z'),
        new Date('2026-07-14T00:00:00.000Z'),
      );
      await fs.utimes(
        artifactPath,
        new Date('2026-07-14T00:01:00.000Z'),
        new Date('2026-07-14T00:01:00.000Z'),
      );

      const report = await readQuantValidationReport(projectPath);
      const staleCheck = report?.checks.find(
        (check) => check.id === 'validation_report_stale',
      );

      expect(report?.status).toBe(status);
      expect(staleCheck).toMatchObject({
        status: 'warning',
        metadata: {
          reasons: ['artifact_modified_after_report'],
          staleArtifactPaths: ['data_file/final/dashboard-data.json'],
        },
      });
    },
  );

  it('treats a report from another generation run as stale', () => {
    expect(
      assessQuantValidationReportFreshness({
        reportRunId: 'run-previous',
        currentRunId: 'run-current',
        reportMtimeMs: 200,
        artifacts: [{ path: 'app/page.tsx', mtimeMs: 100 }],
      }),
    ).toMatchObject({
      stale: true,
      reasons: ['run_id_mismatch'],
      staleArtifactPaths: [],
      reportRunId: 'run-previous',
      currentRunId: 'run-current',
    });
  });

  it('compares a persisted report with the active generation-state request', async () => {
    const projectPath = await createProject();
    const reportPath = path.join(
      projectPath,
      '.quantpilot',
      'validation.json',
    );
    const generationStatePath = path.join(
      projectPath,
      '.quantpilot',
      'generation-state.json',
    );
    await writeJson(reportPath, validationReport('passed', 'run-previous'));
    await writeJson(generationStatePath, {
      schemaVersion: 1,
      projectId: 'project-stale-report',
      requestId: 'run-current',
      status: 'running',
    });
    await fs.utimes(
      generationStatePath,
      new Date('2026-07-14T00:00:00.000Z'),
      new Date('2026-07-14T00:00:00.000Z'),
    );
    await fs.utimes(
      reportPath,
      new Date('2026-07-14T00:01:00.000Z'),
      new Date('2026-07-14T00:01:00.000Z'),
    );

    const report = await readQuantValidationReport(projectPath);
    expect(
      report?.checks.find((check) => check.id === 'validation_report_stale'),
    ).toMatchObject({
      metadata: {
        reasons: ['run_id_mismatch'],
        reportRunId: 'run-previous',
        currentRunId: 'run-current',
      },
    });
  });

  it('keeps the current run report fresh when covered artifacts are not newer', () => {
    expect(
      assessQuantValidationReportFreshness({
        reportRunId: 'run-current',
        currentRunId: 'run-current',
        reportMtimeMs: 200,
        artifacts: [
          { path: 'app/page.tsx', mtimeMs: 100 },
          { path: 'package.json', mtimeMs: 200 },
        ],
      }),
    ).toEqual({
      stale: false,
      reasons: [],
      staleArtifactPaths: [],
      newestArtifactMtimeMs: null,
      reportRunId: 'run-current',
      currentRunId: 'run-current',
    });
  });
});
