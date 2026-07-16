import { describe, expect, it } from 'vitest';

import { buildEvalTraceDiagnostics } from './trace-diagnostics';

describe('evaluation trace diagnostics', () => {
  it('attributes an oracle failure to the data stage', () => {
    const diagnostic = buildEvalTraceDiagnostics({
      passed: false,
      failures: ['oracle:symbol 标的不匹配'],
      validation: { checks: [{ id: 'final_data_file', status: 'passed' }] },
      artifacts: { oracle: { passed: false } },
      eventAudit: { errorCount: 0, warningCount: 0, stages: ['planning'] },
    }, 'contract');
    expect(diagnostic.primaryFailureStage).toBe('intent');
    expect(diagnostic.stages.find((stage) => stage.id === 'data')?.status).toBe('failed');
  });

  it('fails runtime and acceptance for unexpected tool failures without a receipt', () => {
    const diagnostic = buildEvalTraceDiagnostics({
      failures: [],
      agentExecution: {
        executed: true,
        missionStatus: 'running',
        tools: { unexpectedFailureCount: 1 },
      },
      eventAudit: { errorCount: 0, warningCount: 0 },
    }, 'e2e');
    expect(diagnostic.stages.find((stage) => stage.id === 'runtime')?.status).toBe('failed');
    expect(diagnostic.stages.find((stage) => stage.id === 'acceptance')?.status).toBe('failed');
  });
});
