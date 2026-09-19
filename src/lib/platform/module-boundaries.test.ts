import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { importedSpecifiers, validateDeclaredDependencies } = createRequire(import.meta.url)(
  '../../../scripts/checks/check-module-boundaries.js',
);

const config = { modules: [
  { id: 'consumer', paths: ['src/consumer/**'], dependsOn: ['library'], publicSurface: [] },
  { id: 'library', paths: ['src/library/**'], dependsOn: [], publicSurface: ['@/library/index'] },
] };
const sources = (entry: string) => new Map([
  ['src/consumer/main.ts', entry],
  ['src/library/index.ts', 'export const value = 1;'],
  ['src/library/private.ts', 'export const secret = 2;'],
]);

describe('module import boundaries', () => {
  it('parses actual imports without inventing dependencies from comments or generated code', () => {
    expect(importedSpecifiers([
      '// import secret from "@/forbidden";',
      'const template = `import hidden from "@/template";`;',
      'import type { Value } from "@/public/types";',
      'export { value } from "@/public/index";',
      'const lazy = import("@/public/lazy");',
      'const loaded = require("@/public/commonjs");',
      'type Shape = import("@/public/shape").Shape;',
    ].join('\n'))).toEqual([
      '@/public/types', '@/public/index', '@/public/lazy', '@/public/commonjs', '@/public/shape',
    ]);
  });

  it.each([
    'import { secret } from "@/library/private";',
    'export { secret } from "../library/private";',
    'const lazy = import("@/library/private");',
    'const loaded = require("../library/private");',
    'type Secret = import("@/library/private").Secret;',
  ])('rejects private imports regardless of syntax: %s', (source) => {
    expect(validateDeclaredDependencies(config, sources(source))).toEqual([
      expect.stringContaining('imports private module'),
    ]);
  });

  it('rejects new production files without ownership', () => {
    const input = sources('import { value } from "@/library";');
    input.set('src/unowned.ts', 'export const unused = true;');
    expect(validateDeclaredDependencies(config, input)).toEqual([
      'src/unowned.ts has no module ownership',
    ]);
  });

  it('rejects an undeclared dependency even when the imported interface is public', () => {
    const restricted = { modules: config.modules.map(module => ({ ...module, dependsOn: [] })) };
    expect(validateDeclaredDependencies(restricted, sources('import { value } from "@/library";')))
      .toEqual([expect.stringContaining('without declaring dependsOn')]);
  });

  it('does not let production code import white-box tests', () => {
    const input = sources('import "../library/private.test";');
    input.set('src/library/private.test.ts', 'import { secret } from "./private";');
    expect(validateDeclaredDependencies(config, input)).toEqual([
      expect.stringContaining('imports test-only module'),
    ]);
  });

  it('rejects missing and foreign public interfaces', () => {
    const invalid = { modules: config.modules.map(module => ({
      ...module, publicSurface: ['@/missing', '@/consumer/main'],
    })) };
    expect(validateDeclaredDependencies(invalid, sources(''))).toContain(
      'library exports missing or foreign module @/consumer/main',
    );
  });
});
