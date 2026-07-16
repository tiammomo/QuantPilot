import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
}));

import { GET } from './route';

const context = { params: Promise.resolve({ project_id: 'project-1' }) };

describe('project artifact file policy', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-policy-'));
    await fs.writeFile(path.join(workspace, '.env'), 'API_TOKEN=secret', 'utf8');
    await fs.writeFile(path.join(workspace, 'preview.png'), Buffer.from([1, 2, 3]));
    await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'linked-config'));
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      repoPath: workspace,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('returns not found for environment and credential paths', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/projects/project-1/artifact?path=.env'),
      context,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'File not found',
    });
  });

  it('continues serving non-sensitive generated artifacts', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/projects/project-1/artifact?path=preview.png'),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it('cannot bypass the sensitive path policy through a symlink', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/projects/project-1/artifact?path=linked-config'),
      context,
    );

    expect(response.status).toBe(404);
  });
});
