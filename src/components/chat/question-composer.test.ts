import { describe, expect, it } from 'vitest';
import {
  buildQuestionInstruction,
  buildQuickQuestions,
  QUESTION_COMPOSER_COPY,
  QUESTION_MODE_COPY,
  questionOutputLabel,
} from './question-composer';

describe('question composer', () => {
  it('builds user-facing output labels and contextual examples', () => {
    expect(questionOutputLabel('act')).toBe('生成交互看板');
    expect(questionOutputLabel('chat')).toBe('只做分析问答');
    expect(QUESTION_MODE_COPY.act.label).toBe('生成看板');
    expect(QUESTION_COMPOSER_COPY.defaultPlaceholder).toContain('量化需求');
    expect(QUESTION_COMPOSER_COPY.modelRewriteHelper).toContain('不做关键词预判');
    expect(buildQuickQuestions('大位科技')[0]).toContain('大位科技');
    expect(buildQuickQuestions('分析大位科技最近20个交易日，生成技术面看板')[0]).toContain('当前标的');
  });

  it('keeps the visible question intact while constraining chat-only execution', () => {
    expect(buildQuestionInstruction('  分析贵州茅台  ', 'act')).toBe('分析贵州茅台');
    const chatInstruction = buildQuestionInstruction('分析贵州茅台', 'chat');
    expect(chatInstruction).toContain('分析贵州茅台');
    expect(chatInstruction).toContain('Do not modify code or generate a dashboard');
  });
});
