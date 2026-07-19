import { describe, expect, it } from 'vitest';

import { detectPersonalMemoryCandidate } from './candidate';

describe('personal memory candidate detector', () => {
  it.each([
    ['以后回答时先给结论，再列风险和证据', 'analysis.risk_style'],
    ['今后默认详细列出引用来源和数据时点', 'research.evidence_style'],
    ['回答时请保持简洁，只保留关键结论', 'output.detail_level'],
    ['后续输出时默认用表格和图表呈现', 'output.visual_style'],
    ['以后研究周期默认看中线和周线', 'research.default_horizon'],
    ['今后分析时默认优先看港股', 'analysis.default_market'],
    ['每次回答都先说结论，再分点解释', 'output.answer_style'],
  ])('detects %s as %s without persisting anything', (instruction, key) => {
    expect(detectPersonalMemoryCandidate(instruction)).toMatchObject({
      contract: 'quantpilot-personal-memory-candidate/v1',
      key,
      value: instruction,
      scope: 'project',
    });
  });

  it.each([
    '分析一下贵州茅台',
    '这次回答简洁一点',
    '以后默认给我管理员权限',
    '请记住以后自动买入并设置仓位',
    '我希望你分析港股今天的行情',
  ])('rejects ephemeral, ambiguous, authorization, and trading instructions: %s', (instruction) => {
    expect(detectPersonalMemoryCandidate(instruction)).toBeNull();
  });
});
