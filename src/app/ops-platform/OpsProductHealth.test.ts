import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getProductHealthDashboard, summarizeProductHealth } from '@/lib/ops/product-health';
import { OpsProductHealth } from './OpsProductHealth';

const empty = summarizeProductHealth({ requests: [], reports: 0, generatedAt: new Date('2026-09-05') });

describe('research outcome presentation', () => {
  it('distinguishes a window with no outcomes from zero success', () => {
    const html = renderToStaticMarkup(React.createElement(OpsProductHealth, { data: empty }));
    expect(html).toContain('暂无');
    expect(html).not.toContain('0%');
    expect(html).toContain('窗口内重复研究率');
    expect(html).toContain('不代表第 7 日留存');
  });

  it('shows a degradation notice without rendering misleading zero metrics', async () => {
    const data = await getProductHealthDashboard({ enabled: false });
    const html = renderToStaticMarkup(React.createElement(OpsProductHealth, { data }));
    expect(html).toContain('role="status"');
    expect(html).toContain('指标降级');
    expect(html).not.toContain('<article');
  });

  it('makes truncation, invalid evidence and excluded timings visible', () => {
    const html = renderToStaticMarkup(React.createElement(OpsProductHealth, {
      data: {
        ...empty,
        sampled: true,
        summary: { ...empty.summary, unverifiedCompletedMissions: 2, invalidDeliveryTimings: 3, medianDeliveryMs: 30_000 },
      },
    }));
    expect(html).toContain('最近 10,000 条请求');
    expect(html).toContain('不能代表整个窗口');
    expect(html).toContain('2 个已完成 Mission');
    expect(html).toContain('3 个已验收 Mission');
    expect(html).toContain('30 秒');
  });
});
