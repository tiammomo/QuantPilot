import { describe, expect, it } from 'vitest';

import { applyEvalEvaluator, isCurrentEvaluation } from './evaluators';

function result() {
  return {
    passed: true,
    failures: [],
    repairAttempts: 0,
    validation: {
      checks: [
        { id: 'artifact_policy', status: 'passed' },
        { id: 'next_build', status: 'passed' },
        { id: 'final_data_file', status: 'passed' },
        { id: 'evidence_files', status: 'passed' },
        { id: 'visual_presentation', status: 'passed' },
      ],
    },
    artifacts: { oracle: { passed: true } },
    eventAudit: { errorCount: 0, warningCount: 0 },
  };
}

describe('evaluation strategy dispatch', () => {
  it.each([
    { validation: { checks: [{ id: 'next_build', status: 'failed' }] } },
    { validation: { status: 'failed' } },
    { artifacts: { status: 'failed' } },
    { artifacts: { oracle: { passed: true, checks: [{ passed: false, severity: 'error' }] } } },
    { failures: ['unresolved failure'] },
    { eventAudit: { errorCount: -1 } },
    { eventAudit: { errorCount: '0' } },
    { agentExecution: { tools: { unexpectedFailureCount: Number.NaN } } },
  ])('rejects contradictory aggregate success: %j', override => {
    expect(applyEvalEvaluator({ evaluatorId: 'rule-strict', mode: 'contract', result: { ...result(), ...override } }))
      .toMatchObject({ hardGatePassed: false, passed: false });
  });

  it.each(['score', 'weight', 'duplicate', 'rubric', 'status', 'verdict'])(
    'rejects a tampered report field: %s', field => {
      const evaluation = applyEvalEvaluator({ evaluatorId: 'rule-strict', mode: 'contract', result: result() });
      expect(isCurrentEvaluation(evaluation)).toBe(true);
      if (field === 'score') evaluation.score = 1;
      if (field === 'weight') evaluation.dimensions[0].weight = 99;
      if (field === 'duplicate') evaluation.dimensions[0] = evaluation.dimensions[1];
      if (field === 'rubric') evaluation.rubricVersion = 'unsupported';
      if (field === 'status') evaluation.dimensions[0].status = 'failed';
      if (field === 'verdict') evaluation.hardGatePassed = false;
      expect(isCurrentEvaluation(evaluation)).toBe(false);
    }
  );
  it('applies the strict rule rubric with all score dimensions', () => {
    const evaluation = applyEvalEvaluator({
      evaluatorId: 'rule-strict',
      mode: 'contract',
      result: result(),
    });
    expect(evaluation.passed).toBe(true);
    expect(evaluation.dimensions).toHaveLength(7);
    expect(evaluation.checks[0]?.id).toBe('strict_contract');
  });

  it('fails the agent evaluator closed without a semantic review', () => {
    const evaluation = applyEvalEvaluator({
      evaluatorId: 'agent-review',
      mode: 'e2e',
      result: result(),
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks[0]?.id).toBe('semantic_review');
  });

  it('rejects unsupported evaluator modes', () => {
    expect(() => applyEvalEvaluator({
      evaluatorId: 'agent-review',
      mode: 'contract',
      result: result(),
    })).toThrow('不支持 contract');
  });

  it('projects forbidden-language oracle failures into the safety dimension', () => {
    const unsafe = {
      ...result(),
      passed: false,
      artifacts: {
        oracle: {
          passed: false,
          checks: [{
            id: 'no-guarantee',
            target: 'page',
            operator: 'not_matches',
            severity: 'error',
            passed: false,
          }],
        },
      },
    };
    const evaluation = applyEvalEvaluator({
      evaluatorId: 'rule-strict',
      mode: 'contract',
      result: unsafe,
    });
    expect(evaluation.dimensions.find((item) => item.id === 'safety')?.score).toBe(0);
    expect(evaluation.passed).toBe(false);
  });

  it('fails closed on visual, event and unexpected tool hard failures', () => {
    const evaluation = applyEvalEvaluator({
      evaluatorId: 'rule-strict',
      mode: 'e2e',
      result: {
        ...result(),
        visualCheck: { passed: false },
        eventAudit: { errorCount: 1, warningCount: 0 },
        agentExecution: { tools: { unexpectedFailureCount: 1 } },
      },
    });
    expect(evaluation.hardGatePassed).toBe(false);
    expect(evaluation.passed).toBe(false);
  });
});
