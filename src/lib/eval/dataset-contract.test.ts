import { describe, expect, it } from 'vitest';

import { attestEvalDatasetRegistry, type EvalDatasetRegistry } from './dataset-contract';

const registry: EvalDatasetRegistry = {
  schemaVersion: 1,
  snapshotManifest: 'snapshot-manifest.json',
  datasets: [
    { id: 'public', version: '1', visibility: 'public', split: 'regression', path: 'cases.json', required: true },
    { id: 'hidden', version: '1', visibility: 'hidden', split: 'holdout', pathEnv: 'HIDDEN_PATH', required: false },
  ],
};

describe('evaluation dataset contract', () => {
  it('keeps external holdout prompts disjoint from public prompts', () => {
    const result = attestEvalDatasetRegistry({
      registry,
      publicCases: [{ id: 'public-1', question: '分析贵州茅台' }],
      externalDatasets: { hidden: [{ id: 'hidden-1', question: '分析宁德时代' }] },
    });
    expect(result.passed).toBe(true);
  });

  it('rejects prompt contamination and repository paths for hidden data', () => {
    const result = attestEvalDatasetRegistry({
      registry: {
        ...registry,
        datasets: [
          registry.datasets[0],
          { id: 'hidden', version: '1', visibility: 'hidden', split: 'holdout', path: 'hidden.json', required: true },
        ],
      },
      publicCases: [{ id: 'public-1', question: '分析贵州茅台' }],
      externalDatasets: { hidden: [{ id: 'hidden-1', question: '  分析贵州茅台  ' }] },
    });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      'hidden 非公开 dataset 只能通过 pathEnv 注入，禁止仓库内明文 path',
      'hidden prompt 与 public dataset 重叠：hidden-1',
    ]));
  });
});
