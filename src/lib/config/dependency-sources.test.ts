import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { inspectDependencySources } = require('../../../scripts/checks/check-dependency-sources.js') as {
  inspectDependencySources(lock: object): { failures: string[]; packages: number };
};
function lock(resolved: string, integrity = `sha512-${'A'.repeat(86)}==`) {
  return { lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { resolved, integrity } } };
}

describe('dependency source policy', () => {
  it('accepts pinned official tarballs', () => {
    expect(inspectDependencySources(lock('https://registry.npmjs.org/example/-/example-1.0.0.tgz'))).toEqual({ packages: 1, failures: [] });
  });
  it.each([
    'https://registry.npmjs.org.evil.test/example.tgz',
    'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
    'http://registry.npmjs.org/example.tgz',
    'https://secret@registry.npmjs.org/example.tgz',
    'https://registry.npmjs.org/example.tgz?token=secret',
    'file:../example',
  ])('rejects an untrusted package source without exposing credentials: %s', (resolved) => {
    const { failures } = inspectDependencySources(lock(resolved));
    expect(failures).toHaveLength(1);
    expect(failures.join()).not.toContain('secret');
  });
  it('rejects missing integrity and incomplete lockfiles', () => {
    expect(inspectDependencySources(lock('https://registry.npmjs.org/example.tgz', '')).failures).toHaveLength(1);
    expect(inspectDependencySources({}).failures).toHaveLength(1);
  });
});
