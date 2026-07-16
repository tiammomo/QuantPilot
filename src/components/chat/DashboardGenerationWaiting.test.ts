import { describe, expect, it } from 'vitest';

import {
  getDashboardGenerationWaitingCopy,
  resolveDashboardGenerationWaitingStage,
} from './DashboardGenerationWaiting';

describe('dashboard generation waiting copy', () => {
  it('keeps generation and preview states distinct', () => {
    expect(getDashboardGenerationWaitingCopy('generating').title).toContain('生成');
    expect(getDashboardGenerationWaitingCopy('preview').title).toContain('准备');
  });

  it('does not imply a fabricated percentage', () => {
    const copy = Object.values(getDashboardGenerationWaitingCopy('generating')).join(' ');
    expect(copy).not.toMatch(/\d+%/);
    expect(copy).toContain('自动展示');
  });

  it.each([
    ['正在理解问题并生成执行计划', 'planning'],
    ['正在准备数据和可视化看板，验证通过后自动展示', 'data'],
    ['正在生成、验证并准备最终可视化看板', 'generation'],
    ['代码生成完成，正在验证并准备最终看板', 'validation'],
  ] as const)('maps “%s” to the real %s stage', (message, expectedStage) => {
    expect(resolveDashboardGenerationWaitingStage('generating', message).id).toBe(expectedStage);
  });

  it('uses the final stage while the preview service is starting', () => {
    expect(
      resolveDashboardGenerationWaitingStage('preview', '正在检查依赖').id,
    ).toBe('preview');
  });
});
