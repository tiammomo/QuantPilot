import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import TurnMetricsFooter from './TurnMetricsFooter';

describe('TurnMetricsFooter', () => {
  it('renders an inline, non-card summary with the requested totals', () => {
    const html = renderToStaticMarkup(
      React.createElement(TurnMetricsFooter, {
        metrics: {
          schemaVersion: 1,
          elapsedMs: 138_000,
          agentRunCount: 2,
          modelTurnCount: 7,
          inputTokens: 32_810,
          outputTokens: 3_610,
          totalTokens: 36_420,
          cachedInputTokens: 25_000,
          cacheMissInputTokens: 7_810,
          reasoningTokens: 1_200,
          tokenAccounting: 'provider',
          contextSnapshot: {
            schemaVersion: 1,
            runId: 'run-a',
            model: 'test-model',
            turn: 7,
            observedAt: 1_780_000_000_000,
            source: 'estimated',
            inputTokens: 600,
            inputBudgetTokens: 800,
            contextWindowTokens: 1000,
            reservedOutputTokens: 100,
            compacted: true,
          },
        },
      })
    );

    expect(html).toContain('本轮耗时 2 分 18 秒');
    expect(html).toContain('Tokens 36,420');
    expect(html).toContain('输入 32,810');
    expect(html).toContain('输出 3,610');
    expect(html).toContain('末次上下文约 600 / 800 Token');
    expect(html).toContain('已压缩');
    expect(html).toContain('test-model');
    expect(html).toContain('保留输出 100 Token');
    expect(html).not.toContain('rounded');
    expect(html).not.toContain('bg-');
  });

  it('labels non-provider and partial accounting honestly', () => {
    const html = renderToStaticMarkup(
      React.createElement(TurnMetricsFooter, {
        metrics: {
          schemaVersion: 1,
          elapsedMs: 500,
          agentRunCount: 1,
          modelTurnCount: 1,
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cachedInputTokens: 0,
          cacheMissInputTokens: 10,
          reasoningTokens: 0,
          tokenAccounting: 'partial',
        },
      })
    );

    expect(html).toContain('Tokens 约 12');
    expect(html).toContain('统计可能不完整');
    expect(html).toContain('上下文未记录');
    expect(html).not.toContain('末次上下文约 0');
  });
});
