import { isDeepStrictEqual } from 'node:util';

type JsonRecord = Record<string, unknown>;
const HASH = /^sha256:[a-f0-9]{64}$/;
const HASH_KEYS = ['experiment_id', 'data_sha256', 'result_sha256'] as const;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

// Check the archive/reference contract. Numerical integrity is verified by the Python replay CLI.
export async function inspectBacktestArtifact(params: {
  backtest: unknown;
  rawFiles: string[];
  readArtifact: (relativePath: string) => Promise<unknown>;
}): Promise<string[]> {
  const backtest = record(params.backtest);
  if (!backtest) return ['缺少 backtest 结果。'];
  if (Object.hasOwn(backtest, 'experiment')) return ['final 回测不应重复包含实验输入。'];
  if (!Object.hasOwn(backtest, 'experiment_ref')) {
    return params.rawFiles.some(file => file.endsWith('/backtest-ma-crossover.json'))
      ? [] : ['缺少历史回测 raw 产物。'];
  }

  const ref = record(backtest.experiment_ref);
  if (!ref || HASH_KEYS.some(key => typeof ref[key] !== 'string' || !HASH.test(ref[key]))) {
    return ['回测实验引用缺少有效的实验、输入或结果摘要。'];
  }
  if (Object.keys(ref).some(key => !['artifact_path', ...HASH_KEYS].includes(key))) {
    return ['回测实验引用应只包含归档路径和摘要。'];
  }
  const artifactPath = ref.artifact_path;
  const filename = `backtest-ma-crossover-${String(ref.experiment_id).slice(7)}.json`;
  if (
    typeof artifactPath !== 'string'
    || !/^data_file\/raw\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/[^/]+$/.test(artifactPath)
    || artifactPath.split('/').some(part => part === '.' || part === '..')
    || !artifactPath.endsWith(`/${filename}`)
    || !params.rawFiles.includes(artifactPath)
  ) return ['回测实验引用必须指向本次预取归档中与实验 ID 对应的安全路径。'];

  const raw = record(await params.readArtifact(artifactPath));
  const experiment = record(raw?.experiment);
  const data = record(experiment?.data);
  if (!raw || !experiment || experiment.schema_version !== 1) {
    return ['回测归档缺少受支持的实验记录。'];
  }
  const failures: string[] = [];
  if (HASH_KEYS.some(key => experiment[key] !== ref[key])) {
    failures.push('回测归档与 final 引用的摘要不一致。');
  }
  if (!Array.isArray(data?.bars) || data.bars.length < 1 || data.bars.length > 1500) {
    failures.push('回测归档缺少有界的行情输入。');
  }
  const { experiment: _experiment, ...archivedResult } = raw;
  const { experiment_ref: _reference, ...displayedResult } = backtest;
  if (!isDeepStrictEqual(archivedResult, displayedResult)) {
    failures.push('final 回测结果与归档结果不一致。');
  }
  return failures;
}
