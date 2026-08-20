import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDashboardChatContext,
  projectDashboardChatData,
} from './dashboard-chat';

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

async function createProjectArtifacts(input: {
  dataRunId: string;
  validationRunId: string;
  validationPassed?: boolean;
}) {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-dashboard-chat-'));
  temporaryProjects.push(projectPath);
  await Promise.all([
    fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true }),
    fs.mkdir(path.join(projectPath, '.data-agent'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify({
        runId: input.dataRunId,
        requestedSymbols: ['000607', '000608'],
        assets: [{ symbol: '000608', name: '阳光股份', kline: { bars: [1, 2, 3] } }],
      }),
    ),
    fs.writeFile(
      path.join(projectPath, '.data-agent', 'validation.json'),
      JSON.stringify({
        status: input.validationPassed === false ? 'failed' : 'passed',
        passed: input.validationPassed !== false,
        runId: input.validationRunId,
        checks: [{ id: 'next_build', status: 'passed', summary: '构建通过' }],
      }),
    ),
  ]);
  return projectPath;
}

describe('dashboard read-only chat context', () => {
  it('keeps decision evidence while excluding raw market payloads and K-lines', () => {
    const projected = projectDashboardChatData({
      generatedAt: '2026-08-20T09:03:45.588Z',
      requestedSymbols: ['000607', '000608'],
      comparison: { rows: [{ symbol: '000608', composite_score: 80 }] },
      assets: [
        {
          symbol: '000608',
          name: '阳光股份',
          quote: { price: '7.39', raw: { secret: 'drop' } },
          computedMetrics: { return120d: 98.66, maxDrawdown: -27.88 },
          kline: { bars: Array.from({ length: 120 }, (_, index) => ({ index })) },
        },
      ],
    });

    expect(projected).toMatchObject({
      available: true,
      requestedSymbols: ['000607', '000608'],
      assets: [
        {
          symbol: '000608',
          quote: { price: '7.39' },
          computedMetrics: { return120d: 98.66 },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain('kline');
    expect(JSON.stringify(projected)).not.toContain('secret');
  });

  it('exposes data only when final data, validation, and Mission receipt identify the same accepted run', async () => {
    const projectPath = await createProjectArtifacts({
      dataRunId: 'accepted-run',
      validationRunId: 'accepted-run',
    });
    const readAcceptedMission = vi.fn().mockResolvedValue({
      missionId: 'mission-1',
      generationId: 'generation-1',
      projectId: 'project-a',
      requestId: 'accepted-run',
      missionStatus: 'completed',
      candidateVersion: 1,
      acceptedReceiptId: 'receipt-1',
      acceptedReceiptHash: `sha256:${'a'.repeat(64)}`,
      acceptedAt: '2026-08-20T09:04:00.000Z',
      previewUrl: 'http://localhost:4104',
      previewPort: 4104,
    });

    await expect(buildDashboardChatContext(
      { projectId: 'project-a', projectPath },
      { readAcceptedMission },
    )).resolves.toMatchObject({
      dashboard: {
        available: true,
        requestedSymbols: ['000607', '000608'],
      },
      validation: {
        status: 'passed',
        checks: [{ id: 'next_build', status: 'passed' }],
      },
      evidenceBoundary: {
        acceptedRequestId: 'accepted-run',
        acceptedReceiptId: 'receipt-1',
      },
    });
    expect(readAcceptedMission).toHaveBeenCalledWith('project-a', 'accepted-run');
  });

  it('fails closed before consulting Mission state when candidate data and validation belong to different runs', async () => {
    const projectPath = await createProjectArtifacts({
      dataRunId: 'failed-candidate',
      validationRunId: 'older-accepted-run',
    });
    const readAcceptedMission = vi.fn();

    await expect(buildDashboardChatContext(
      { projectId: 'project-a', projectPath },
      { readAcceptedMission },
    )).resolves.toMatchObject({
      dashboard: { available: false },
      validation: { status: 'unavailable' },
      evidenceBoundary: { acceptedRequestId: null },
    });
    expect(readAcceptedMission).not.toHaveBeenCalled();
  });
});
