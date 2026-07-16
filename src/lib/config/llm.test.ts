import { afterEach, describe, expect, it } from 'vitest';
import { getProjectLlmConfig } from './llm';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('project LLM config', () => {
  it('exposes a complete secret-free DeepSeek project contract', () => {
    const config = getProjectLlmConfig();

    expect(config).toEqual(expect.objectContaining({
      schemaVersion: 1,
      profileId: 'deepseek-v4-flash',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      credentialEnv: 'DEEPSEEK_API_KEY',
      agent: { enabled: true },
      queryRewrite: expect.objectContaining({
        enabled: true,
        mode: 'auto',
        timeoutMs: 4_000,
        maxRetries: 0,
      }),
    }));
    expect(JSON.stringify(config)).not.toContain(process.env.DEEPSEEK_API_KEY ?? '__missing__');
  });

  it('applies bounded operational overrides without changing provider identity', () => {
    process.env.QUANTPILOT_LLM_AGENT_ENABLED = '0';
    process.env.QUANTPILOT_LLM_QUERY_REWRITE_ENABLED = 'false';
    process.env.QUANTPILOT_QUERY_REWRITE_LLM_MODE = 'always';
    process.env.QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS = '6500';
    process.env.QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES = '1';

    expect(getProjectLlmConfig()).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      agent: { enabled: false },
      queryRewrite: {
        enabled: false,
        mode: 'always',
        timeoutMs: 6_500,
        maxRetries: 1,
      },
    });
  });
});
