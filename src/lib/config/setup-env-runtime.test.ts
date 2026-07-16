import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applyRuntimeEnvUpdates,
  normalizeGeneratedEnvValue,
} = require('../../../scripts/dev/setup-env.js') as {
  applyRuntimeEnvUpdates: (
    updates: Record<string, string>,
    options?: { overwrite?: boolean; target?: Record<string, string | undefined> },
  ) => void;
  normalizeGeneratedEnvValue: (value: string) => string;
};

describe('development setup runtime environment updates', () => {
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
