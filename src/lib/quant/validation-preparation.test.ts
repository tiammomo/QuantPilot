import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareQuantProjectForValidation } from './validation';

const temporaryProjects: string[] = [];
let previousSettleTimeout: string | undefined;

beforeEach(() => {
  previousSettleTimeout = process.env.QUANTPILOT_VALIDATION_SETTLE_TIMEOUT_MS;
  process.env.QUANTPILOT_VALIDATION_SETTLE_TIMEOUT_MS = '1';
});

afterEach(async () => {
  if (previousSettleTimeout === undefined) {
    delete process.env.QUANTPILOT_VALIDATION_SETTLE_TIMEOUT_MS;
  } else {
    process.env.QUANTPILOT_VALIDATION_SETTLE_TIMEOUT_MS = previousSettleTimeout;
  }
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

async function fileState(projectPath: string, relativePath: string) {
  const absolutePath = path.join(projectPath, relativePath);
  const [content, stat] = await Promise.all([
    fs.readFile(absolutePath, 'utf8'),
    fs.stat(absolutePath),
  ]);
  return { content, mtimeMs: stat.mtimeMs };
}

describe('quant validation preparation', () => {
  it('normalizes generated build inputs once and remains content-idempotent', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-validation-prep-'));
    temporaryProjects.push(projectPath);

    await Promise.all([
      fs.writeFile(
        path.join(projectPath, 'package.json'),
        `${JSON.stringify({
          name: 'generated-project',
          scripts: { build: 'next build' },
          dependencies: { 'next-rspack': '^0.8.1' },
        }, null, 2)}\n`,
        'utf8',
      ),
      fs.writeFile(path.join(projectPath, 'postcss.config.js'), 'module.exports = {};\n', 'utf8'),
      fs.writeFile(
        path.join(projectPath, 'next.config.js'),
        `/** @type {import('next').NextConfig} */
const withRspack = require('next-rspack');
const nextConfig = {
};
module.exports = withRspack(nextConfig);
`,
        'utf8',
      ),
    ]);

    const resolvedPath = await prepareQuantProjectForValidation({
      projectId: 'project-validation-prep',
      projectPath,
    });
    expect(resolvedPath).toBe(path.resolve(projectPath));

    const trackedPaths = [
      'package.json',
      'postcss.config.js',
      'next.config.js',
      'scripts/run-build.js',
    ];
    const firstState = Object.fromEntries(
      await Promise.all(
        trackedPaths.map(async (relativePath) => [
          relativePath,
          await fileState(projectPath, relativePath),
        ]),
      ),
    );

    await prepareQuantProjectForValidation({
      projectId: 'project-validation-prep',
      projectPath,
    });

    const secondState = Object.fromEntries(
      await Promise.all(
        trackedPaths.map(async (relativePath) => [
          relativePath,
          await fileState(projectPath, relativePath),
        ]),
      ),
    );

    expect(secondState).toEqual(firstState);
    expect(JSON.parse(firstState['package.json'].content)).toMatchObject({
      scripts: { build: 'node scripts/run-build.js' },
      dependencies: { next: expect.any(String) },
    });
    expect(firstState['package.json'].content).not.toContain('next-rspack');
    expect(firstState['postcss.config.js'].content).toContain('plugins: []');
    expect(firstState['next.config.js'].content).not.toContain('next-rspack');
    expect(firstState['next.config.js'].content).toContain('root: workspaceRoot');
  });
});
