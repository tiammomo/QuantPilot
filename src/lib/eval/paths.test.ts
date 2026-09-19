import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let fixture: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

it('shares evaluation paths with standalone and pins the release behind current', async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-root-'));
  const release = path.join(fixture, 'release-a');
  const nextRelease = path.join(fixture, 'release-b');
  const current = path.join(fixture, 'current');
  const standalone = path.join(release, '.next', 'standalone');
  await fs.mkdir(standalone, { recursive: true });
  await fs.mkdir(nextRelease);
  await fs.symlink(release, current);
  vi.stubEnv('QUANTPILOT_EVAL_ROOT', current);
  vi.spyOn(process, 'cwd').mockReturnValue(standalone);
  vi.resetModules();
  const paths = await import('./paths');
  expect(paths.ROOT).toBe(release);
  expect(paths.REPORTS_DIR).toBe(path.join(release, 'tmp', 'quantpilot-benchmark-reports'));
  await fs.unlink(current);
  await fs.symlink(nextRelease, current);
  expect(paths.ROOT).toBe(release);
});
