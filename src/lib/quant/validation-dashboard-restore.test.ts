import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isQuantDashboardTemplateRecoveryEligible,
  restoreQuantDashboardTemplateAfterRepairExhaustion,
  type QuantValidationCheck,
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

function failedReport(failedCheckIds: string[]): QuantValidationReport {
  const timestamp = '2026-07-14T00:00:00.000Z';
  const checks: QuantValidationCheck[] = failedCheckIds.map((id) => ({
    id,
    name: id,
    status: 'failed',
    summary: `${id} failed`,
  }));
  return {
    schemaVersion: 1,
    projectId: 'dashboard-restore-test',
    reportPath: '.data-agent/validation.json',
    status: 'failed',
    passed: false,
    checks,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function createGeneratedProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-dashboard-restore-'));
  temporaryProjects.push(projectPath);

  const protectedContents = {
    runPlan: `${JSON.stringify({
      schemaVersion: 1,
      visualization: { templateId: 'single-stock-diagnosis' },
    }, null, 2)}\n`,
    finalData: `${JSON.stringify({
      symbol: '600111',
      name: '北方稀土',
      source: 'market-data-service',
      as_of: '2026-07-14T00:00:00.000Z',
      quote: { price: 42.75 },
      visualization: { template_id: 'single-stock-diagnosis' },
      preservationMarker: 'keep-final-byte-for-byte',
    }, null, 2)}\n`,
    sources: `${JSON.stringify({
      schemaVersion: 1,
      sources: [{ name: 'market-data-service', url: '/api/market/quote' }],
      preservationMarker: 'keep-sources-byte-for-byte',
    }, null, 2)}\n`,
    dataQuality: `${JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      warnings: [],
      preservationMarker: 'keep-quality-byte-for-byte',
    }, null, 2)}\n`,
  };

  await Promise.all([
    fs.mkdir(path.join(projectPath, '.data-agent'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'app'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'evidence'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(projectPath, '.data-agent', 'finance-run-plan.json'), protectedContents.runPlan, 'utf8'),
    fs.writeFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), protectedContents.finalData, 'utf8'),
    fs.writeFile(path.join(projectPath, 'evidence', 'sources.json'), protectedContents.sources, 'utf8'),
    fs.writeFile(path.join(projectPath, 'evidence', 'data_quality.json'), protectedContents.dataQuality, 'utf8'),
    fs.writeFile(path.join(projectPath, 'app', 'page.tsx'), 'export default function BrokenPage() { return <main>BROKEN_AGENT_PAGE</main>; }\n', 'utf8'),
    fs.writeFile(path.join(projectPath, 'app', 'globals.css'), '.broken-agent-page { color: hotpink; }\n', 'utf8'),
  ]);

  return { projectPath, protectedContents };
}

describe('dashboard template restore fallback', () => {
  it('only declares presentation-only reports eligible for deterministic recovery', () => {
    expect(isQuantDashboardTemplateRecoveryEligible(
      failedReport(['visual_presentation', 'chart_presence']),
    )).toBe(true);
    expect(isQuantDashboardTemplateRecoveryEligible(
      failedReport(['visual_presentation', 'final_data_file']),
    )).toBe(false);
  });

  it('restores the platform page for presentation-only failures and preserves final/evidence', async () => {
    const { projectPath, protectedContents } = await createGeneratedProject();
    const result = await restoreQuantDashboardTemplateAfterRepairExhaustion({
      projectPath,
      report: failedReport([
        'next_build',
        'preview_http_200',
        'visual_presentation',
        'dashboard_data_binding',
        'chart_presence',
      ]),
    });

    expect(result).toMatchObject({
      restored: true,
      failedCheckIds: [
        'next_build',
        'preview_http_200',
        'visual_presentation',
        'dashboard_data_binding',
        'chart_presence',
      ],
    });
    expect(result.reason).toContain('需重新运行验证');

    const restoredPage = await fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8');
    expect(restoredPage).not.toContain('BROKEN_AGENT_PAGE');
    expect(restoredPage).toContain('data-source-file={DATA_FILE}');
    expect(restoredPage).toContain('function getBars(');
    expect(restoredPage).toContain('K 线与量价结构');
    await expect(fs.readFile(path.join(projectPath, '.data-agent', 'finance-run-plan.json'), 'utf8'))
      .resolves.toBe(protectedContents.runPlan);
    await expect(fs.readFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), 'utf8'))
      .resolves.toBe(protectedContents.finalData);
    await expect(fs.readFile(path.join(projectPath, 'evidence', 'sources.json'), 'utf8'))
      .resolves.toBe(protectedContents.sources);
    await expect(fs.readFile(path.join(projectPath, 'evidence', 'data_quality.json'), 'utf8'))
      .resolves.toBe(protectedContents.dataQuality);
  });

  it('refuses a mixed page/data failure without overwriting the generated page', async () => {
    const { projectPath, protectedContents } = await createGeneratedProject();
    const originalPage = await fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8');
    const result = await restoreQuantDashboardTemplateAfterRepairExhaustion({
      projectPath,
      report: failedReport(['chart_presence', 'final_data_file']),
    });

    expect(result.restored).toBe(false);
    expect(result.reason).toContain('final_data_file');
    await expect(fs.readFile(path.join(projectPath, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe(originalPage);
    await expect(fs.readFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), 'utf8'))
      .resolves.toBe(protectedContents.finalData);
    await expect(fs.readFile(path.join(projectPath, 'evidence', 'sources.json'), 'utf8'))
      .resolves.toBe(protectedContents.sources);
    await expect(fs.readFile(path.join(projectPath, 'evidence', 'data_quality.json'), 'utf8'))
      .resolves.toBe(protectedContents.dataQuality);
  });
});
