import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { QuantRunPlan } from '@/lib/quant/workspace';
import {
  buildWorkspaceProgressMessage,
  WORKSPACE_PROGRESS_STAGE_LABELS,
} from './workspace-response';

function plan(overrides: Partial<QuantRunPlan> = {}): QuantRunPlan {
  return {
    schemaVersion: 1,
    runId: 'run-workspace-response',
    status: 'planned',
    capabilityId: 'stock_diagnosis',
    question: '八亿时投这个股票最近怎么样',
    symbols: ['600589'],
    timeRange: '最近 1 年',
    dataRequirements: ['实时行情', '历史 K 线', '技术指标', '财务摘要', '公告事件'],
    analysisSteps: ['取数', '分析', '生成'],
    visualization: {
      required: true,
      templateId: 'single-stock-diagnosis',
      variantName: '个股作战台',
      panels: ['行情', 'K 线'],
    },
    expectedArtifacts: ['app/page.tsx'],
    validationRules: ['必须构建通过'],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('workspace response protocol', () => {
  it('stays synchronized with the shared Skills presentation contract', async () => {
    const registry = JSON.parse(await fs.readFile(
      path.join(process.cwd(), 'config', 'moagent-skill-capsules.json'),
      'utf8',
    )) as { workspaceResponseContract?: { owner?: string; stageLabels?: string[] } };

    expect(registry.workspaceResponseContract?.owner).toBe('platform');
    expect(registry.workspaceResponseContract?.stageLabels).toEqual(
      [...WORKSPACE_PROGRESS_STAGE_LABELS],
    );
  });

  it('builds the first progress message from the authoritative run plan', () => {
    const content = buildWorkspaceProgressMessage({ stage: 1, runPlan: plan() });

    expect(content).toContain('【进度 1/5】正在理解问题');
    expect(content).toContain('| 维度 | 初步识别 | 状态 |');
    expect(content).toContain('| 业务场景 | 个股诊断 | 明确 |');
    expect(content).toContain('| 分析对象 | 600589 | 明确 |');
    expect(content).toContain('| 时间范围 | 最近 1 年 | 平台默认 |');
    expect(content).toContain('用户原问句：八亿时投这个股票最近怎么样');
  });

  it('marks an inferred time range as a platform default', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({ question: '分析贵州茅台', timeRange: '最近 1 年' }),
    });

    expect(content).toContain('| 时间范围 | 最近 1 年 | 平台默认 |');
  });

  it('marks an explicitly requested time window as clear', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({ question: '分析贵州茅台最近 120 个交易日', timeRange: '最近 120 个交易日' }),
    });

    expect(content).toContain('| 时间范围 | 最近 120 个交易日 | 明确 |');
  });

  it('strips legacy operational prompt suffixes from the visible original question', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({
        question: '分析贵州茅台\n\n请默认使用中文输出可见的执行过程摘要。\n### 任务拆解',
      }),
    });

    expect(content).toContain('用户原问句：分析贵州茅台');
    expect(content).not.toContain('### 任务拆解');
  });

  it('stops at clarification instead of claiming that data lookup is starting', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 1,
      runPlan: plan({
        status: 'needs_clarification',
        symbols: [],
        clarification: {
          required: true,
          reason: '存在多个同优先级标的',
          missing: ['target'],
          questions: ['请确认具体标的。'],
          confidence: 0.4,
        },
      }),
    });

    expect(content).toContain('先完成必要澄清');
    expect(content).not.toContain('开始核验真实数据和任务合同');
  });

  it('does not claim completion for a failed terminal projection', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      failureReason: '持久预览 HTTP 就绪检查失败',
    });

    expect(content).toContain('【进度 5/5】未完成');
    expect(content).not.toContain('【进度 5/5】已完成');
    expect(content).toContain('持久预览 HTTP 就绪检查失败');
  });

  it('only describes accepted validation and preview in the success projection', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      validationCheckCount: 12,
      previewUrl: 'http://127.0.0.1:3000',
    });

    expect(content).toContain('【进度 5/5】已完成');
    expect(content).toContain('12 项检查完成，无阻断项');
    expect(content).toContain('独立证据验收：通过');
    expect(content).toContain('http://127.0.0.1:3000');
  });

  it('reports validation warnings without claiming that every check passed', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      validationCheckCount: 12,
      validationWarningCount: 2,
      previewUrl: 'http://127.0.0.1:3000',
    });

    expect(content).toContain('12 项检查完成（2 项提示）');
    expect(content).not.toContain('12 项通过');
  });

  it('uses a paused terminal projection for user cancellation', () => {
    const content = buildWorkspaceProgressMessage({
      stage: 5,
      cancelledReason: '用户暂停了当前任务',
    });

    expect(content).toContain('【进度 5/5】已暂停');
    expect(content).not.toContain('【进度 5/5】未完成');
  });
});
