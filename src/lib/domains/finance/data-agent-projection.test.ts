import { describe, expect, it } from 'vitest';

import type { QuantQueryRewriteResult } from './query-rewrite';
import { projectFinanceRewriteToDataAgentTask } from './data-agent-projection';

describe('finance Data Agent projection', () => {
  it('projects verified symbols into generic resolved entities', () => {
    const rewrite = {
      schemaVersion: 4,
      originalQuery: '分析大位科技',
      normalizedQuery: '分析大位科技',
      rewrittenQuery: '分析大位科技的行情与基本面',
      status: 'ready',
      confidence: 0.95,
      capabilityHint: 'stock_diagnosis',
      targetCandidates: ['大位科技'],
      resolvedSymbols: [{
        query: '大位科技', symbol: '600589', name: '大位科技', market: 'SH',
        assetType: 'stock', secid: '1.600589', source: 'market-data', confidence: 1,
      }],
      unresolvedTargets: [], ambiguousTargets: [], timeRange: null,
      analysisFocus: { id: 'comprehensive', label: '综合分析' },
      outputIntent: 'dashboard', broadUniverse: false,
      safety: { decision: 'allow', code: null, message: null }, issues: [],
      execution: {
        strategy: 'llm_primary',
        llm: {
          attempted: true, applied: true, trigger: 'primary', status: 'applied',
          provider: 'openai', model: 'local_qwen:qwen3.5-9b-q5km', durationMs: 10,
          semanticConfidence: 0.95, guardedFields: [], errorCode: null, usage: null,
        },
      },
    } satisfies QuantQueryRewriteResult;

    const task = projectFinanceRewriteToDataAgentTask(rewrite);
    expect(task.resolvedEntities).toEqual([expect.objectContaining({
      entityType: 'finance.security',
      canonicalId: '600589',
      displayName: '大位科技',
    })]);
    expect(task.domainHints).toContain('finance.quant');
  });
});
