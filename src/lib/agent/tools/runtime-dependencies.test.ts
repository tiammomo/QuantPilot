import fs from 'node:fs/promises';
import path from 'node:path';

import postcss from 'postcss';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('MoAgent runtime parser dependencies', () => {
  it('keeps semantic-edit parsers in production dependencies and loadable', async () => {
    const root = process.cwd();
    const [manifest, lock] = await Promise.all([
      fs.readFile(path.join(root, 'package.json'), 'utf8').then(
        (value) => JSON.parse(value) as PackageManifest,
      ),
      fs.readFile(path.join(root, 'package-lock.json'), 'utf8').then(
        (value) => JSON.parse(value) as { packages?: Record<string, PackageManifest> },
      ),
    ]);

    for (const dependency of ['postcss', 'typescript']) {
      expect(manifest.dependencies?.[dependency]).toEqual(expect.any(String));
      expect(manifest.devDependencies).not.toHaveProperty(dependency);
      expect(lock.packages?.['']?.dependencies?.[dependency]).toEqual(expect.any(String));
      expect(lock.packages?.['']?.devDependencies).not.toHaveProperty(dependency);
    }

    expect(postcss.parse('.root { color: red; }').nodes).toHaveLength(1);
    const sourceFile = ts.createSourceFile(
      'page.tsx',
      'export default function Page() { return <main />; }',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect((sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.Diagnostic[];
    }).parseDiagnostics ?? []).toHaveLength(0);
  });
});
