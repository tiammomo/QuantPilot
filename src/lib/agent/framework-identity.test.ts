import { describe, expect, it, vi } from 'vitest';

import {
  fingerprintUntrackedFiles,
  MOAGENT_FRAMEWORK_VERSION,
  resolveMoAgentBuildIdentity,
} from './framework-identity';

describe('MoAgent framework identity', () => {
  it('uses the single 1.7 framework version and an explicit immutable build revision', () => {
    const readGitRevision = vi.fn(() => 'a'.repeat(40));

    expect(resolveMoAgentBuildIdentity({
      environment: {
        NODE_ENV: 'test',
        MOAGENT_BUILD_REVISION: 'image:sha256-deadbeef',
      },
      readGitRevision,
      readWorkspaceFingerprint: () => null,
    })).toEqual({
      frameworkVersion: 'moagent:1.7.0',
      buildRevision: 'image:sha256-deadbeef',
      gitRevision: 'a'.repeat(40),
    });
    expect(MOAGENT_FRAMEWORK_VERSION).toBe('moagent:1.7.0');
  });

  it('prefers deployment git provenance and rejects malformed revision input', () => {
    const readGitRevision = vi.fn(() => 'b'.repeat(40));

    expect(resolveMoAgentBuildIdentity({
      environment: {
        NODE_ENV: 'test',
        MOAGENT_BUILD_REVISION: 'contains spaces and is invalid',
        GITHUB_SHA: 'C'.repeat(40),
      },
      readGitRevision,
      readWorkspaceFingerprint: () => null,
    })).toEqual({
      frameworkVersion: 'moagent:1.7.0',
      buildRevision: 'c'.repeat(40),
      gitRevision: 'c'.repeat(40),
    });
    expect(readGitRevision).not.toHaveBeenCalled();
  });

  it('fails visibly to an unversioned identity outside a git checkout', () => {
    expect(resolveMoAgentBuildIdentity({
      environment: { NODE_ENV: 'test' },
      readGitRevision: () => null,
      readWorkspaceFingerprint: () => null,
    })).toEqual({
      frameworkVersion: 'moagent:1.7.0',
      buildRevision: 'unversioned:moagent:1.7.0',
      gitRevision: null,
    });
  });

  it('binds a local dirty build to a bounded workspace fingerprint', () => {
    expect(resolveMoAgentBuildIdentity({
      environment: { NODE_ENV: 'test' },
      readGitRevision: () => 'd'.repeat(40),
      readWorkspaceFingerprint: () => 'diff0123456789',
    })).toEqual({
      frameworkVersion: 'moagent:1.7.0',
      buildRevision: `${'d'.repeat(40)}-dirty.diff0123456789`,
      gitRevision: 'd'.repeat(40),
    });
  });

  it('binds untracked paths and contents deterministically within a hard budget', () => {
    const contents = new Map([
      ['/repo/src/new-agent.ts', Buffer.from('version one')],
      ['/repo/docs/new.md', Buffer.from('documentation')],
    ]);
    const readEntry = vi.fn((absolutePath: string) => ({
      kind: 'file' as const,
      content: contents.get(absolutePath) ?? Buffer.alloc(0),
    }));
    const original = fingerprintUntrackedFiles(
      ['src/new-agent.ts', 'docs/new.md'],
      { cwd: '/repo', maxContentBytes: 64, readEntry },
    );

    expect(fingerprintUntrackedFiles(
      ['docs/new.md', 'src/new-agent.ts'],
      { cwd: '/repo', maxContentBytes: 64, readEntry },
    )).toBe(original);

    contents.set('/repo/src/new-agent.ts', Buffer.from('version two'));
    expect(fingerprintUntrackedFiles(
      ['src/new-agent.ts', 'docs/new.md'],
      { cwd: '/repo', maxContentBytes: 64, readEntry },
    )).not.toBe(original);

    expect(() => fingerprintUntrackedFiles(
      ['src/new-agent.ts', 'docs/new.md'],
      { cwd: '/repo', maxContentBytes: 8, readEntry },
    )).toThrow(/exceeds fingerprint budget/);
  });
});
