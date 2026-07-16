import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  listEnvVars: vi.fn(),
  createEnvVar: vi.fn(),
  updateEnvVar: vi.fn(),
  deleteEnvVar: vi.fn(),
  upsertEnvVar: vi.fn(),
  detectEnvConflicts: vi.fn(),
  syncDbToEnvFile: vi.fn(),
  syncEnvFileToDb: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/env', () => ({
  listEnvVars: mocks.listEnvVars,
  createEnvVar: mocks.createEnvVar,
  updateEnvVar: mocks.updateEnvVar,
  deleteEnvVar: mocks.deleteEnvVar,
  upsertEnvVar: mocks.upsertEnvVar,
  detectEnvConflicts: mocks.detectEnvConflicts,
  syncDbToEnvFile: mocks.syncDbToEnvFile,
  syncEnvFileToDb: mocks.syncEnvFileToDb,
}));

import { GET as listEnv, POST as createEnv } from './route';
import { DELETE as deleteEnv, PUT as updateEnv } from './[key]/route';
import { GET as getConflicts } from './conflicts/route';
import { POST as syncDbToFile } from './sync/db-to-file/route';
import { POST as syncFileToDb } from './sync/file-to-db/route';
import { POST as upsertEnv } from './upsert/route';

const projectParams = { params: Promise.resolve({ project_id: 'project-1' }) };
const keyParams = { params: Promise.resolve({ project_id: 'project-1', key: 'API_KEY' }) };

function request(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

describe('/api/env project secret authorization', () => {
  beforeEach(() => {
    mocks.requireAction.mockResolvedValue({});
    mocks.listEnvVars.mockResolvedValue([]);
    mocks.createEnvVar.mockResolvedValue({ key: 'API_KEY' });
    mocks.updateEnvVar.mockResolvedValue(true);
    mocks.deleteEnvVar.mockResolvedValue(true);
    mocks.upsertEnvVar.mockResolvedValue({ key: 'API_KEY' });
    mocks.detectEnvConflicts.mockResolvedValue({ conflicts: [] });
    mocks.syncDbToEnvFile.mockResolvedValue(0);
    mocks.syncEnvFileToDb.mockResolvedValue(0);
  });

  it('requires owner-only secret read for list and conflict detection', async () => {
    await listEnv(request('/api/env/project-1'), projectParams);
    await getConflicts(request('/api/env/project-1/conflicts'), projectParams);

    expect(mocks.requireAction).toHaveBeenNthCalledWith(1, {
      headers: expect.any(Headers),
      action: 'project.secrets.read',
      projectId: 'project-1',
    });
    expect(mocks.requireAction).toHaveBeenNthCalledWith(2, {
      headers: expect.any(Headers),
      action: 'project.secrets.read',
      projectId: 'project-1',
    });
  });

  it('requires owner-only secret write for every mutation and synchronization route', async () => {
    await createEnv(
      request('/api/env/project-1', 'POST', { key: 'API_KEY', value: 'secret' }),
      projectParams,
    );
    await updateEnv(
      request('/api/env/project-1/API_KEY', 'PUT', { value: 'updated' }),
      keyParams,
    );
    await deleteEnv(request('/api/env/project-1/API_KEY', 'DELETE'), keyParams);
    await upsertEnv(
      request('/api/env/project-1/upsert', 'POST', { key: 'API_KEY', value: 'secret' }),
      projectParams,
    );
    await syncDbToFile(request('/api/env/project-1/sync/db-to-file', 'POST'), projectParams);
    await syncFileToDb(request('/api/env/project-1/sync/file-to-db', 'POST'), projectParams);

    expect(mocks.requireAction).toHaveBeenCalledTimes(6);
    for (const [input] of mocks.requireAction.mock.calls) {
      expect(input).toMatchObject({
        action: 'project.secrets.write',
        projectId: 'project-1',
      });
    }
  });
});
