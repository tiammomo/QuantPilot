import { describe, expect, it, vi } from 'vitest';
import { inspectBacktestArtifact } from './backtest-artifact';

function fixture() {
  const hashes = {
    experiment_id: `sha256:${'a'.repeat(64)}`,
    data_sha256: `sha256:${'b'.repeat(64)}`,
    result_sha256: `sha256:${'c'.repeat(64)}`,
  };
  const artifactPath = `data_file/raw/run-1/510300/backtest-ma-crossover-${'a'.repeat(64)}.json`;
  const result = { summary: { total_return_pct: '1.23' }, equity_curve: [{ equity: '101.23' }] };
  const raw = {
    ...result,
    experiment: { schema_version: 1, ...hashes, data: { bars: [{ close: '10.123456789' }] } },
  };
  return {
    raw,
    backtest: { ...result, experiment_ref: { artifact_path: artifactPath, ...hashes } },
    rawFiles: [artifactPath],
    readArtifact: vi.fn(async () => raw as unknown),
  };
}

describe('backtest archive inspection', () => {
  it('follows the captured reference and permits legacy artifacts without claiming replay', async () => {
    const input = fixture();
    expect(await inspectBacktestArtifact(input)).toEqual([]);
    expect(input.readArtifact).toHaveBeenCalledWith(input.rawFiles[0]);
    expect(await inspectBacktestArtifact({
      backtest: { summary: {} }, rawFiles: ['data_file/raw/run/510300/backtest-ma-crossover.json'],
      readArtifact: input.readArtifact,
    })).toEqual([]);
    expect(await inspectBacktestArtifact({ backtest: {}, rawFiles: [], readArtifact: input.readArtifact }))
      .not.toEqual([]);
  });

  it.each([
    '../../private.json',
    '/tmp/private.json',
    `data_file/raw/run-1/../backtest-ma-crossover-${'a'.repeat(64)}.json`,
    `data_file/raw/run-1/510300/backtest-ma-crossover-${'d'.repeat(64)}.json`,
  ])('rejects unsafe or mismatched paths before reading: %s', async artifactPath => {
    const input = fixture();
    input.backtest.experiment_ref.artifact_path = artifactPath;
    input.rawFiles = [artifactPath];
    expect(await inspectBacktestArtifact(input)).not.toEqual([]);
    expect(input.readArtifact).not.toHaveBeenCalled();
  });

  it('rejects unlisted references and malformed digests before reading', async () => {
    const input = fixture();
    expect(await inspectBacktestArtifact({ ...input, rawFiles: [] })).not.toEqual([]);
    input.backtest.experiment_ref.data_sha256 = 'unknown';
    expect(await inspectBacktestArtifact(input)).not.toEqual([]);
    expect(input.readArtifact).not.toHaveBeenCalled();
  });

  it.each(['missing', 'schema', 'hash', 'bars', 'result', 'duplicated_inputs'])(
    'rejects a broken archive contract: %s', async mutation => {
      const input = fixture();
      if (mutation === 'missing') input.readArtifact.mockResolvedValue(null);
      if (mutation === 'schema') input.raw.experiment.schema_version = 2;
      if (mutation === 'hash') input.raw.experiment.result_sha256 = `sha256:${'d'.repeat(64)}`;
      if (mutation === 'bars') input.raw.experiment.data.bars = [];
      if (mutation === 'result') input.raw.summary = { total_return_pct: '999' };
      if (mutation === 'duplicated_inputs') Object.assign(input.backtest, { experiment: input.raw.experiment });
      expect(await inspectBacktestArtifact(input)).not.toEqual([]);
    }
  );
});
