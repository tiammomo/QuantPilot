import { describe, expect, it } from 'vitest';
import {
  buildQuickQuestions,
  inferQuestionFocus,
  inferQuestionTimeRange,
  inferSymbolSearchQuery,
  questionOutputLabel,
} from './question-composer';

describe('question composer recognition', () => {
  it('extracts explicit codes, known aliases and project-name fallbacks', () => {
    expect(inferSymbolSearchQuery('分析 600589 最近走势')).toBe('600589');
    expect(inferSymbolSearchQuery('贵州茅台最近财务怎么样')).toBe('贵州茅台');
    expect(inferSymbolSearchQuery('看近60日趋势', '大位科技的股票怎么样')).toBe('大位科技');
  });

  it('summarizes time ranges and analysis focus', () => {
    expect(inferQuestionTimeRange('看近 60 个交易日的量价趋势')).toBe('近60交易日');
    expect(inferQuestionTimeRange('分析今年的公告')).toBe('今年');
    expect(inferQuestionFocus('比较两只股票的财务和估值')).toBe('标的对比');
    expect(inferQuestionFocus('执行均线策略回测')).toBe('策略回测');
  });

  it('builds user-facing output labels and contextual examples', () => {
    expect(questionOutputLabel('act')).toBe('生成交互看板');
    expect(questionOutputLabel('chat')).toBe('只做分析问答');
    expect(buildQuickQuestions('大位科技的股票怎么样')[0]).toContain('大位科技');
  });
});
