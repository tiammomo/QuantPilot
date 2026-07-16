import { describe, expect, it } from 'vitest';

import {
  getProjectAuthConfig,
  getProjectAuthSecret,
  getDevelopmentAdminDefaults,
  isPublicAuthPath,
} from './auth';

describe('project auth config', () => {
  it('keeps authentication disabled by default for local upgrade compatibility', () => {
    const config = getProjectAuthConfig({ NODE_ENV: 'development' });
    expect(config).toMatchObject({
      schemaVersion: 1,
      mode: 'disabled',
      enabled: false,
      basePath: '/api/auth',
      allowSignUp: false,
      secureCookies: false,
      password: {
        minLength: 12,
        argon2id: { memoryCostKiB: 19_456, timeCost: 2, parallelism: 1 },
      },
      rateLimit: { signInMaxRequests: 5 },
      retention: { auditDays: 180, expiredRecordGraceSeconds: 3_600 },
      bootstrap: {
        developmentDefaults: {
          login: 'admin',
          email: 'admin@quantpilot.local',
          password: 'admin',
        },
      },
    });
  });

  it('accepts bounded authentication retention overrides', () => {
    const config = getProjectAuthConfig({
      QUANTPILOT_AUTH_AUDIT_RETENTION_DAYS: '365',
      QUANTPILOT_AUTH_EXPIRED_RECORD_GRACE_SECONDS: '7200',
    });
    expect(config.retention).toEqual({
      auditDays: 365,
      expiredRecordGraceSeconds: 7_200,
    });
  });

  it('offers admin/admin only for non-strict localhost development', () => {
    const config = getProjectAuthConfig({ NODE_ENV: 'development' });
    expect(getDevelopmentAdminDefaults(config, {
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'http://localhost:3000',
    })).toMatchObject({ login: 'admin', password: 'admin' });
    expect(getDevelopmentAdminDefaults(config, {
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'http://localhost:3000',
    })).toBeNull();
    expect(getDevelopmentAdminDefaults(config, {
      NODE_ENV: 'development',
      QUANTPILOT_DEGRADATION_MODE: 'strict',
      BETTER_AUTH_URL: 'http://localhost:3000',
    })).toBeNull();
    expect(getDevelopmentAdminDefaults(config, {
      NODE_ENV: 'development',
      BETTER_AUTH_URL: 'https://quant.example.com',
    })).toBeNull();
  });

  it('enables local auth only with an explicit mode and requires a strong secret', () => {
    const environment = {
      NODE_ENV: 'production',
      QUANTPILOT_AUTH_MODE: 'local',
      QUANTPILOT_AUTH_SECRET: 'a'.repeat(32),
      QUANTPILOT_AUTH_TRUSTED_ORIGINS: 'https://quant.example.com,http://127.0.0.1:3000',
    };
    const config = getProjectAuthConfig(environment);
    expect(config).toMatchObject({ mode: 'local', enabled: true, secureCookies: true });
    expect(config.trustedOrigins).toEqual([
      'https://quant.example.com',
      'http://127.0.0.1:3000',
    ]);
    expect(getProjectAuthSecret(config, environment)).toBe('a'.repeat(32));
  });

  it('fails closed when local auth has no deploy secret', () => {
    const config = getProjectAuthConfig({ QUANTPILOT_AUTH_MODE: 'local' });
    expect(() => getProjectAuthSecret(config, {})).toThrow('未配置或少于 32 个字符');
  });

  it('recognizes only configured public path prefixes', () => {
    const config = getProjectAuthConfig({});
    expect(isPublicAuthPath('/login', config)).toBe(true);
    expect(isPublicAuthPath('/api/auth/get-session', config)).toBe(true);
    expect(isPublicAuthPath('/api/projects', config)).toBe(false);
  });
});
