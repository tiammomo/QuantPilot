import { describe, expect, it } from 'vitest';

import { parseAgentSemanticReview } from './agent-reviewer';

describe('agent semantic reviewer', () => {
  it('normalizes the fixed rubric and recomputes the verdict', () => {
    const review = parseAgentSemanticReview(`\`\`\`json
      {
        "summary": "证据完整，但行动建议略弱。",
        "dimensions": [
          {"id":"intentCoverage","score":90,"rationale":"覆盖问题","evidence":["runPlan"]},
          {"id":"businessCompleteness","score":88,"rationale":"结构完整","evidence":["finalData"]},
          {"id":"grounding","score":82,"rationale":"来源可追溯","evidence":["sources"]},
          {"id":"riskCommunication","score":80,"rationale":"说明限制","evidence":["quality"]},
          {"id":"actionability","score":70,"rationale":"建议一般","evidence":[]}
        ]
      }
    \`\`\``);

    expect(review).toMatchObject({
      schemaVersion: 1,
      verdict: 'warning',
      score: 82,
      reviewer: { promptVersion: 'quantpilot-agent-review-prompt-v1' },
    });
    expect(review.dimensions).toHaveLength(5);
  });

  it('fails closed when a required rubric dimension is absent', () => {
    const review = parseAgentSemanticReview('{"summary":"partial","dimensions":[]}');
    expect(review.verdict).toBe('failed');
    expect(review.score).toBe(0);
  });
});
