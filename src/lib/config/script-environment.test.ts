import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { loadProjectEnvironment } = require('../../../scripts/shared/load-env.js') as {
  loadProjectEnvironment(options: { rootDir: string; target: Record<string, string | undefined> }): Record<string, string | undefined>;
};
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('CLI environment precedence', () => {
  it('keeps injected credentials above local overrides and shared defaults', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantpilot-env-'));
    roots.push(rootDir);
    fs.writeFileSync(path.join(rootDir, '.env'), 'DATABASE_URL=default-db\nTOKEN=default-token\nPORT=35433\n');
    fs.writeFileSync(path.join(rootDir, '.env.local'), 'DATABASE_URL=local-db\nTOKEN=local-token\n');
    const target = { TOKEN: 'injected-token' };

    expect(loadProjectEnvironment({ rootDir, target })).toEqual({
      DATABASE_URL: 'local-db', TOKEN: 'injected-token', PORT: '35433',
    });
  });

  it('supports environment-only processes and preserves intentional empty overrides', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantpilot-env-'));
    roots.push(rootDir);
    const target = { TOKEN: '' };
    expect(loadProjectEnvironment({ rootDir, target })).toEqual({ TOKEN: '' });
    fs.writeFileSync(path.join(rootDir, '.env'), 'TOKEN=default-token\n');
    expect(loadProjectEnvironment({ rootDir, target })).toEqual({ TOKEN: '' });
  });
});
