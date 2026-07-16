import { describe, expect, it } from 'vitest';

import { resolveLoginEmail } from './login-identity';

describe('login identity', () => {
  const developmentAdmin = {
    login: 'admin',
    email: 'admin@quantpilot.local',
  };

  it('maps the local admin alias to the credential email', () => {
    expect(resolveLoginEmail(' Admin ', developmentAdmin)).toBe('admin@quantpilot.local');
  });

  it('normalizes regular email identities without rewriting them', () => {
    expect(resolveLoginEmail(' User@Example.com ', developmentAdmin)).toBe('user@example.com');
  });

  it('does not enable the admin alias outside local development', () => {
    expect(resolveLoginEmail('admin', null)).toBe('admin');
  });
});
