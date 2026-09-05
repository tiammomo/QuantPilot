import { describe, expect, it } from 'vitest';

import {
  repositoryAvailabilityMessage,
  sanitizeRepositoryName,
  validateRepositoryName,
} from './github-repository';

describe('GitHub repository naming', () => {
  it('normalizes project labels into GitHub-safe names', () => {
    expect(sanitizeRepositoryName('  Quant 研究_Project  ')).toBe('quant-project');
    expect(sanitizeRepositoryName('..Alpha---Beta..')).toBe('alpha-beta');
    expect(validateRepositoryName(sanitizeRepositoryName(`${'a'.repeat(99)}-suffix`))).toBe('');
  });

  it.each([400, 401, 403, 500])('does not label an HTTP %i failure as an existing repository', (status) => {
    const result = repositoryAvailabilityMessage({ name: 'alpha', status, available: false });
    expect(result.error).toBe('');
    expect(result.warning).not.toBe('');
  });

  it('requires an explicit availability result before presenting success', () => {
    expect(repositoryAvailabilityMessage({ name: 'alpha', status: 200 }).warning).not.toBe('');
    expect(repositoryAvailabilityMessage({ name: 'alpha', status: 200, available: true })).toEqual({ error: '', warning: '' });
  });

  it('rejects invalid and reserved repository names', () => {
    expect(validateRepositoryName('')).toBe('Repository name is required');
    expect(validateRepositoryName('con')).toBe('Repository name cannot be a reserved name');
    expect(validateRepositoryName('alpha..beta')).toBe('Repository name cannot contain consecutive periods');
    expect(validateRepositoryName('alpha-beta')).toBe('');
  });

  it('blocks conflicts but treats availability outages as warnings', () => {
    expect(repositoryAvailabilityMessage({ name: 'alpha', status: 409 })).toMatchObject({
      error: 'Repository name "alpha" already exists',
      warning: '',
    });
    expect(repositoryAvailabilityMessage({ name: 'alpha', status: 503 }).warning).toContain('HTTP 503');
  });
});
