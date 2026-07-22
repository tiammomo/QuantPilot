import { describe, expect, it } from 'vitest';

import { envVarValueUpdateSchema, envVarWriteSchema } from './env-contract';

describe('environment API contracts', () => {
  it('accepts the current camelCase write contract and applies safe defaults', () => {
    expect(envVarWriteSchema.parse({ key: 'API_KEY', value: 'secret' })).toEqual({
      key: 'API_KEY',
      value: 'secret',
      scope: 'runtime',
      varType: 'string',
      isSecret: true,
    });
  });

  it('rejects legacy aliases, invalid keys and unknown update fields', () => {
    expect(envVarWriteSchema.safeParse({
      key: 'API_KEY',
      value: 'secret',
      var_type: 'string',
      is_secret: true,
    }).success).toBe(false);
    expect(envVarWriteSchema.safeParse({ key: 'BAD-KEY', value: 'secret' }).success).toBe(false);
    expect(envVarValueUpdateSchema.safeParse({ value: 'next', isSecret: false }).success).toBe(false);
  });
});
