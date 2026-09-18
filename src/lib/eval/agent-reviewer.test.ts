import { describe, expect, it } from 'vitest';
import { parseAgentSemanticReview } from './agent-reviewer';
import type { ReviewEvidence } from './review-evidence';

const ids = ['intentCoverage', 'businessCompleteness', 'grounding', 'riskCommunication', 'actionability'];
const evidence = Object.fromEntries(['finalData', 'sources', 'quality', 'runPlan'].map(id => [id, {
  path: `${id}.json`, sha256: `sha256:${'a'.repeat(64)}`, bytes: 20, truncated: false, value: { status: 'observed' },
}])) as ReviewEvidence;
const result = () => ({ summary: 'Evidence checked', dimensions: ids.map(id => ({ id, score: 90, rationale: 'Observed artifact', evidence: ['finalData#/status'] })) });
const parse = (value: unknown, packet = evidence) => parseAgentSemanticReview(JSON.stringify(value), null, { provider: 'openai', model: 'test' }, packet);

describe('agent semantic reviewer', () => {
  it('computes scores only with citations to provided evidence', () => {
    expect(parse(result())).toMatchObject({
      verdict: 'passed', score: 90,
      reviewer: { promptVersion: 'quantpilot-agent-review-prompt-v2', independentFromGenerator: false },
      evidenceValidation: { status: 'verified', issues: [] },
    });
  });
  it.each(['invented', 'empty', 'duplicate', 'missing', 'out_of_range', 'fractional', 'rationale'])(
    'rejects unsupported high scores: %s', mutation => {
      const value = result();
      if (mutation === 'invented') value.dimensions[0].evidence = ['sources#/invented'];
      if (mutation === 'empty') value.dimensions[0].evidence = [];
      if (mutation === 'duplicate') value.dimensions[0].id = value.dimensions[1].id;
      if (mutation === 'missing') value.dimensions.pop();
      if (mutation === 'out_of_range') value.dimensions[0].score = 101;
      if (mutation === 'fractional') value.dimensions[0].score = 90.5;
      if (mutation === 'rationale') value.dimensions[0].rationale = '';
      expect(parse(value)).toMatchObject({ verdict: 'failed', evidenceValidation: { status: 'failed' } });
    }
  );
  it('does not turn omitted evidence into a fully verified pass', () => {
    const packet = structuredClone(evidence);
    packet.finalData.truncated = true;
    expect(parse(result(), packet)).toMatchObject({ verdict: 'warning', evidenceValidation: { truncatedArtifacts: ['finalData'] } });
    expect(parseAgentSemanticReview(JSON.stringify(result()))).toMatchObject({ verdict: 'failed' });
  });
  it('allows negative verdicts without fabricating positive citations', () => {
    const value = result();
    value.dimensions = value.dimensions.map(item => ({ ...item, score: 0, evidence: [] }));
    expect(parse(value)).toMatchObject({ verdict: 'failed', score: 0, evidenceValidation: { status: 'verified' } });
  });
});
