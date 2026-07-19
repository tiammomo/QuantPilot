import { describe, expect, it } from 'vitest';

import { getKnowledgeIntegrationConfig } from './config';

describe('governed knowledge integration config', () => {
  it('is disabled by default in tests', () => {
    const config = getKnowledgeIntegrationConfig({ NODE_ENV: 'test' });

    expect(config.enabled).toBe(false);
    expect(config.required).toBe(false);
    expect(config.apiUrl).toBe('http://localhost:8080');
    expect(config.purpose).toBe('quant-research');
    expect(config.spaces).toEqual(['https://knowledge.local/spaces/default']);
  });

  it('accepts an independent AKEP endpoint and bounded scope', () => {
    const config = getKnowledgeIntegrationConfig({
      NODE_ENV: 'development',
      QUANTPILOT_KNOWLEDGE_ENABLED: '1',
      QUANTPILOT_KNOWLEDGE_REQUIRED: '1',
      QUANTPILOT_KNOWLEDGE_API_URL: 'https://knowledge.example/platform',
      QUANTPILOT_KNOWLEDGE_PURPOSE: 'quant-research',
      QUANTPILOT_KNOWLEDGE_SPACES: 'https://knowledge.example/spaces/research,https://knowledge.example/spaces/risk',
      QUANTPILOT_KNOWLEDGE_TIMEOUT_MS: '900',
      QUANTPILOT_KNOWLEDGE_MAX_CONTEXT_CHARACTERS: '6000',
      QUANTPILOT_KNOWLEDGE_BEARER_TOKEN: 'test-reader',
    });

    expect(config).toMatchObject({
      enabled: true,
      required: true,
      apiUrl: 'https://knowledge.example/platform',
      purpose: 'quant-research',
      timeoutMs: 900,
      maxContextCharacters: 6000,
      bearerToken: 'test-reader',
    });
    expect(config.spaces).toHaveLength(2);
  });

  it('requires OAuth and HTTPS in production', () => {
    expect(() => getKnowledgeIntegrationConfig({
      NODE_ENV: 'production',
      QUANTPILOT_KNOWLEDGE_ENABLED: '1',
      QUANTPILOT_KNOWLEDGE_API_URL: 'https://knowledge.example',
    })).toThrow('requires OAuth client credentials');
    expect(() => getKnowledgeIntegrationConfig({
      NODE_ENV: 'production',
      QUANTPILOT_KNOWLEDGE_ENABLED: '1',
      QUANTPILOT_KNOWLEDGE_API_URL: 'http://knowledge.example',
    })).toThrow('must use HTTPS');
  });
});
