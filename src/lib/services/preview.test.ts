import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  findAvailablePort: vi.fn(),
  getProjectById: vi.fn(),
  checkQuantArtifactPolicy: vi.fn(),
  scaffoldBasicNextApp: vi.fn(),
  ensureQuantDashboardTemplate: vi.fn(),
  spawn: vi.fn(),
  updateProject: vi.fn(),
  updateProjectStatus: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  readlink: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock('fs/promises', () => ({
  default: fsMocks,
  ...fsMocks,
}));

vi.mock('@/lib/utils/ports', () => ({
  findAvailablePort: mocks.findAvailablePort,
}));

vi.mock('@/lib/quant/validation', () => ({
  checkQuantArtifactPolicy: mocks.checkQuantArtifactPolicy,
}));

vi.mock('@/lib/security/generated-project-sandbox', () => ({
  buildGeneratedProjectEnv: (
    projectPath: string,
    overrides: Readonly<Record<string, string | undefined>> = {},
  ) => ({ ...overrides, QUANTPILOT_WORKSPACE_ROOT: projectPath }),
  wrapGeneratedProjectCommand: async (
    _projectPath: string,
    command: string,
    args: string[],
  ) => ({ command, args }),
}));

vi.mock('./project', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
  updateProjectStatus: mocks.updateProjectStatus,
}));

vi.mock('@/lib/utils/scaffold', () => ({
  ensureQuantDashboardTemplate: mocks.ensureQuantDashboardTemplate,
  scaffoldBasicNextApp: mocks.scaffoldBasicNextApp,
}));

vi.mock('@/lib/config/constants', () => ({
  PREVIEW_CONFIG: {
    FALLBACK_PORT_END: 4_100,
    FALLBACK_PORT_START: 4_100,
    HEALTH_CHECK_INTERVAL: 1,
    LOG_LIMIT: 100,
    STARTUP_TIMEOUT: 20,
  },
}));

import { PreviewManager } from './preview';

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  stderr: EventEmitter;
  stdout: EventEmitter;
};

let nextPid = 900_000;

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = nextPid += 1;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

describe('PreviewManager start concurrency', () => {
  beforeEach(() => {
    process.env.PREVIEW_PORT_START = '4100';
    process.env.PREVIEW_PORT_END = '4100';

    mocks.getProjectById.mockResolvedValue({
      id: 'project-preview',
      previewPort: null,
      repoPath: '/tmp/quantpilot-preview-test',
    });
    mocks.checkQuantArtifactPolicy.mockResolvedValue({
      id: 'artifact-policy',
      status: 'passed',
      summary: 'Artifact policy passed.',
    });
    mocks.updateProject.mockResolvedValue(undefined);
    mocks.updateProjectStatus.mockResolvedValue(undefined);
    mocks.findAvailablePort.mockResolvedValue(4_100);
    mocks.scaffoldBasicNextApp.mockResolvedValue(undefined);
    mocks.ensureQuantDashboardTemplate.mockResolvedValue(undefined);
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(new Error('no listeners'));
    });
    mocks.spawn.mockImplementation(() => createFakeChild());

    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.readFile.mockImplementation(async (filePath: unknown) => {
      if (String(filePath).endsWith('package.json')) {
        return JSON.stringify({ scripts: { dev: 'next dev' } });
      }
      throw missingFile();
    });
    fsMocks.readlink.mockRejectedValue(missingFile());
    fsMocks.rename.mockResolvedValue(undefined);
    fsMocks.rm.mockResolvedValue(undefined);
    fsMocks.stat.mockImplementation(async (filePath: unknown) => {
      if (String(filePath).endsWith('node_modules')) {
        return {
          isDirectory: () => true,
          isFile: () => false,
        };
      }
      throw missingFile();
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PREVIEW_PORT_START;
    delete process.env.PREVIEW_PORT_END;
  });

  it('coalesces concurrent starts into one process and one ready result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new PreviewManager();

    const first = manager.start('project-preview');
    const second = manager.start('project-preview');

    expect(first).toBe(second);
    const [firstInfo, secondInfo] = await Promise.all([first, second]);

    expect(firstInfo).toBe(secondInfo);
    expect(firstInfo).toMatchObject({
      port: 4_100,
      status: 'running',
      url: 'http://localhost:4100',
    });
    expect(mocks.getProjectById).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears a failed start so a later call can retry cleanly', async () => {
    let ready = false;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (!ready) {
        throw new Error('not ready');
      }
      return { ok: true, status: 200 };
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new PreviewManager();

    await expect(manager.start('project-preview')).rejects.toThrow(
      'Preview server did not become ready'
    );
    expect(manager.getStatus('project-preview').status).toBe('stopped');

    ready = true;
    await expect(manager.start('project-preview')).resolves.toMatchObject({
      status: 'running',
      url: 'http://localhost:4100',
    });

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('does not erase an already running preview when a later start check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    const manager = new PreviewManager();

    await manager.start('project-preview');
    mocks.updateProject.mockClear();
    mocks.updateProjectStatus.mockClear();
    mocks.getProjectById.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(manager.start('project-preview')).rejects.toThrow(
      'database unavailable'
    );

    expect(manager.getStatus('project-preview').status).toBe('running');
    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.updateProjectStatus).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('discovers an existing project preview with one listener-table snapshot', async () => {
    process.env.PREVIEW_PORT_END = '4199';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        result?: { stderr: string; stdout: string }
      ) => void;
      callback(null, {
        stderr: '',
        stdout: [
          'LISTEN 0 511 127.0.0.1:4108 0.0.0.0:* users:(("next-server",pid=7108,fd=20))',
          'LISTEN 0 511 [::]:4173 [::]:* users:(("next-server",pid=7173,fd=21))',
          'LISTEN 0 511 0.0.0.0:4300 0.0.0.0:* users:(("next-server",pid=7300,fd=22))',
        ].join('\n'),
      });
    });
    fsMocks.readlink.mockImplementation(async (linkPath: unknown) => {
      if (String(linkPath) === '/proc/7173/cwd') {
        return '/tmp/quantpilot-preview-test';
      }
      return '/tmp/a-different-project';
    });

    const manager = new PreviewManager();
    await expect(manager.start('project-preview')).resolves.toMatchObject({
      port: 4_173,
      status: 'running',
      url: 'http://localhost:4173',
    });

    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).toHaveBeenCalledWith(
      'ss',
      ['-ltnpH'],
      expect.any(Function)
    );
    expect(mocks.findAvailablePort).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each(['stop', 'cleanup'] as const)(
    '%s cancels an in-flight start without racing a subsequent start',
    async (method) => {
      let releaseFirstRequest!: (response: { ok: boolean; status: number }) => void;
      const firstRequest = new Promise<{ ok: boolean; status: number }>(
        (resolve) => {
          releaseFirstRequest = resolve;
        }
      );
      const fetchMock = vi.fn().mockImplementation(async () => {
        if (mocks.spawn.mock.calls.length === 1) {
          return firstRequest;
        }
        return { ok: true, status: 200 };
      });
      vi.stubGlobal('fetch', fetchMock);
      const manager = new PreviewManager();

      const interruptedStart = manager.start('project-preview');
      const interruptedAssertion = expect(interruptedStart).rejects.toThrow(
        'Preview start cancelled'
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), {
        interval: 1,
        timeout: 100,
      });

      const shutdown = manager[method]('project-preview');
      const nextStart = manager.start('project-preview');
      releaseFirstRequest({ ok: false, status: 503 });

      await interruptedAssertion;
      await shutdown;
      await expect(nextStart).resolves.toMatchObject({
        status: 'running',
        url: 'http://localhost:4100',
      });

      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(manager.getStatus('project-preview').status).toBe('running');

      const projectUpdateCount = mocks.updateProject.mock.calls.length;
      const statusUpdateCount = mocks.updateProjectStatus.mock.calls.length;
      const interruptedChild = mocks.spawn.mock.results[0]?.value as FakeChild;
      interruptedChild.emit('exit', 0, null);
      await Promise.resolve();

      expect(mocks.updateProject).toHaveBeenCalledTimes(projectUpdateCount);
      expect(mocks.updateProjectStatus).toHaveBeenCalledTimes(statusUpdateCount);
      expect(manager.getStatus('project-preview').status).toBe('running');
    }
  );
});
