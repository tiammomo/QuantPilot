import { describe, expect, it } from 'vitest';

import { attestProductionReplayCase, buildProductionReplayCase, redactEvalPrompt } from './shadow-replay';

describe('production shadow replay privacy', () => {
  it('redacts direct identifiers and retains only evaluation fields', () => {
    const prepared = buildProductionReplayCase({
      question: '我的手机号是13800138000，邮箱 test@example.com，请分析600519',
      capabilityId: 'fundamental_analysis',
      expectedSymbol: '600519',
      userId: 'secret-user',
    }, { hashKey: 'test-only-shadow-hash-key' });
    expect(prepared.question).toContain('[MOBILE]');
    expect(prepared.question).toContain('[EMAIL]');
    expect(prepared).not.toHaveProperty('userId');
    expect(attestProductionReplayCase(prepared)).toEqual({ passed: true, problems: [] });
  });

  it('detects residual direct identifiers', () => {
    const redaction = redactEvalPrompt('分析股票', 'test-only-shadow-hash-key');
    const result = attestProductionReplayCase({
      question: '联系 13800138000',
      privacy: {
        schemaVersion: 1,
        redacted: true,
        sourcePromptHmacSha256: redaction.sourcePromptHmacSha256,
        redactionTypes: [],
      },
    });
    expect(result.passed).toBe(false);
  });
});
