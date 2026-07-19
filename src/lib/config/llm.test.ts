import { afterEach, describe, expect, it } from 'vitest';
import { getProjectLlmConfig } from './llm';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('project LLM config', () => {
  it('exposes a complete secret-free local Qwen project contract by default', () => {
    const config = getProjectLlmConfig();

    expect(config).toEqual(expect.objectContaining({
      schemaVersion: 1,
      profileId: 'local_qwen:qwen3.5-9b-q5km',
      provider: 'openai',
      model: 'local_qwen:qwen3.5-9b-q5km',
      baseUrl: 'http://127.0.0.1:38082/v1',
      credentialEnv: 'MODELPORT_API_KEY',
      agent: { enabled: true },
      queryRewrite: expect.objectContaining({
        enabled: true,
        timeoutMs: 15_000,
        maxRetries: 0,
      }),
    }));
    expect(JSON.stringify(config)).not.toContain(process.env.MODELPORT_API_KEY ?? '__missing__');
  });

  it('applies bounded operational overrides without changing provider identity', () => {
    process.env.QUANTPILOT_LLM_AGENT_ENABLED = '0';
    process.env.QUANTPILOT_LLM_QUERY_REWRITE_ENABLED = 'false';
    process.env.QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS = '6500';
    process.env.QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES = '1';

    expect(getProjectLlmConfig()).toMatchObject({
      provider: 'openai',
      model: 'local_qwen:qwen3.5-9b-q5km',
      agent: { enabled: false },
      queryRewrite: {
        enabled: false,
        timeoutMs: 6_500,
        maxRetries: 1,
      },
    });
  });

  it('keeps the locked DeepSeek profile available when explicitly selected', () => {
    expect(getProjectLlmConfig('deepseek-v4-flash')).toMatchObject({
      profileId: 'deepseek-v4-flash',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://api.deepseek.com',
      credentialEnv: 'DEEPSEEK_API_KEY',
    });
  });

  it('routes the normal DeepSeek profile through ModelPort without an upstream key', () => {
    expect(getProjectLlmConfig('deepseek:deepseek-v4-flash')).toMatchObject({
      profileId: 'deepseek:deepseek-v4-flash',
      provider: 'openai',
      model: 'deepseek:deepseek-v4-flash',
      baseUrl: 'http://127.0.0.1:38082/v1',
      credentialEnv: 'MODELPORT_API_KEY',
    });
  });

  it('resolves the locked local OpenAI-compatible profile without exposing its secret', () => {
    const config = getProjectLlmConfig('local_qwen:qwen3.5-9b-q5km');

    expect(config).toMatchObject({
      schemaVersion: 1,
      profileId: 'local_qwen:qwen3.5-9b-q5km',
      provider: 'openai',
      model: 'local_qwen:qwen3.5-9b-q5km',
      baseUrl: 'http://127.0.0.1:38082/v1',
      credentialEnv: 'MODELPORT_API_KEY',
      agent: { enabled: true },
      queryRewrite: {
        enabled: true,
        timeoutMs: 15_000,
        maxRetries: 0,
      },
    });
    expect(JSON.stringify(config)).not.toContain(
      process.env.MODELPORT_API_KEY ?? '__missing__',
    );
  });
});
