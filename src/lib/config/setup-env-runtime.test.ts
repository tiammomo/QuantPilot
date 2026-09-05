import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applyRuntimeEnvUpdates,
  buildInfrastructureEnvironmentDefaults,
  normalizeGeneratedEnvValue,
} = require('../../../scripts/dev/setup-env.js') as {
  applyRuntimeEnvUpdates: (
    updates: Record<string, string>,
    options?: { overwrite?: boolean; target?: Record<string, string | undefined> },
  ) => void;
  normalizeGeneratedEnvValue: (value: string) => string;
  buildInfrastructureEnvironmentDefaults: (contents: string) => Record<string, string>;
};

describe('development setup runtime environment updates', () => {
  it('keeps generated Docker endpoints aligned with the checked-in defaults', () => {
    const example = parse(readFileSync('.env.example'));
    const updates = buildInfrastructureEnvironmentDefaults('');
    const generated = Object.fromEntries(
      Object.entries(updates).map(([key, value]) => [key, normalizeGeneratedEnvValue(value)]),
    );
    for (const [key, value] of Object.entries(generated)) {
      expect(value, key).toBe(example[key]);
    }

    const compose = readFileSync('docker-compose.yml', 'utf8');
    for (const key of ['POSTGRES_PORT', 'REDIS_PORT', 'CLICKHOUSE_HTTP_PORT', 'CLICKHOUSE_NATIVE_PORT']) {
      expect(compose).toContain(`\${${key}:-${generated[key]}}`);
    }
    const catalog = JSON.parse(readFileSync('config/service-catalog.json', 'utf8'));
    for (const [serviceId, urlKey] of [
      ['timescaledb', 'DATABASE_URL'], ['redis', 'REDIS_URL'], ['clickhouse', 'CLICKHOUSE_URL'],
    ]) {
      const service = catalog.services.find((entry: { id: string }) => entry.id === serviceId);
      expect(new URL(service.endpoint.default).port).toBe(new URL(generated[urlKey]).port);
    }
  });

  it('derives missing URLs from customized Docker ports and encodes database credentials', () => {
    const updates = buildInfrastructureEnvironmentDefaults([
      'POSTGRES_PORT=5544', 'POSTGRES_USER="research user"', 'POSTGRES_PASSWORD="a#b@c/d"',
      'POSTGRES_DB="research lab"', 'REDIS_PORT=6633', 'CLICKHOUSE_HTTP_PORT=8811',
    ].join('\n'));
    expect(normalizeGeneratedEnvValue(updates.DATABASE_URL)).toBe(
      'postgresql://research%20user:a%23b%40c%2Fd@127.0.0.1:5544/research%20lab?schema=public',
    );
    expect(normalizeGeneratedEnvValue(updates.REDIS_URL)).toBe('redis://127.0.0.1:6633/0');
    expect(normalizeGeneratedEnvValue(updates.CLICKHOUSE_URL)).toBe('http://127.0.0.1:8811');
    expect(updates.POSTGRES_PORT).toBeUndefined();
  });

  it('preserves external endpoints when local Docker port settings are absent', () => {
    const updates = buildInfrastructureEnvironmentDefaults([
      'DATABASE_URL=postgresql://external/database', 'REDIS_URL=redis://external:6633/1',
      'CLICKHOUSE_URL=https://external:8443',
    ].join('\n'));
    expect(updates.DATABASE_URL).toBeUndefined();
    expect(updates.REDIS_URL).toBeUndefined();
    expect(updates.CLICKHOUSE_URL).toBeUndefined();
  });

  it('normalizes quoted values before passing them to child processes', () => {
    expect(normalizeGeneratedEnvValue('"http://localhost:3000"')).toBe(
      'http://localhost:3000',
    );
    expect(normalizeGeneratedEnvValue("'local'")).toBe('local');
    expect(normalizeGeneratedEnvValue('3000')).toBe('3000');
  });

  it('applies newly generated trusted origins during the current launch', () => {
    const target = {
      QUANTPILOT_AUTH_TRUSTED_ORIGINS: 'http://localhost:3000',
    };

    applyRuntimeEnvUpdates(
      {
        QUANTPILOT_AUTH_TRUSTED_ORIGINS:
          'http://localhost:3000,http://127.0.0.1:3000',
      },
      { target },
    );

    expect(target.QUANTPILOT_AUTH_TRUSTED_ORIGINS).toBe(
      'http://localhost:3000,http://127.0.0.1:3000',
    );
  });

  it('does not overwrite an explicit runtime value when requested', () => {
    const target = { DATABASE_URL: 'postgresql://explicit/database' };

    applyRuntimeEnvUpdates(
      { DATABASE_URL: 'postgresql://generated/database' },
      { overwrite: false, target },
    );

    expect(target.DATABASE_URL).toBe('postgresql://explicit/database');
  });
});
