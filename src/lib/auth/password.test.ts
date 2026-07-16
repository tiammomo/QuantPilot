import { describe, expect, it } from 'vitest';

import { hashAuthPassword, validateAuthPassword, verifyAuthPassword } from './password';

describe('auth password hashing', () => {
  it('rejects short passwords before hashing', () => {
    expect(validateAuthPassword('short')).toContain('至少需要 12');
  });

  it('hashes with Argon2id and verifies without exposing the password', async () => {
    const password = 'correct horse battery staple';
    const hashed = await hashAuthPassword(password);
    expect(hashed).toContain('$argon2id$');
    expect(hashed).not.toContain(password);
    await expect(verifyAuthPassword(hashed, password)).resolves.toBe(true);
    await expect(verifyAuthPassword(hashed, 'incorrect password')).resolves.toBe(false);
  });

  it('allows admin only through the localhost development bootstrap path', async () => {
    const hashed = await hashAuthPassword('admin', {
      allowDevelopmentDefault: true,
      environment: {
        NODE_ENV: 'development',
        BETTER_AUTH_URL: 'http://localhost:3000',
      },
    });
    await expect(verifyAuthPassword(hashed, 'admin')).resolves.toBe(true);
    await expect(hashAuthPassword('admin', {
      allowDevelopmentDefault: true,
      environment: {
        NODE_ENV: 'production',
        BETTER_AUTH_URL: 'http://localhost:3000',
      },
    })).rejects.toThrow('至少需要 12');
  });
});
