import { createHash } from 'node:crypto';

export type EvalDatasetVisibility = 'public' | 'hidden' | 'production_replay';
export type EvalDatasetSplit = 'smoke' | 'regression' | 'holdout' | 'shadow';

export interface EvalDatasetDefinition {
  id: string;
  version: string;
  visibility: EvalDatasetVisibility;
  split: EvalDatasetSplit;
  path?: string;
  pathEnv?: string;
  required: boolean;
}

export interface EvalDatasetRegistry {
  schemaVersion: 1;
  datasets: EvalDatasetDefinition[];
  snapshotManifest: string;
}

type EvalCaseLike = { id?: unknown; question?: unknown };

export function normalizedPromptHash(value: unknown): string {
  const normalized = String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

export function attestEvalDatasetRegistry(input: {
  registry: EvalDatasetRegistry;
  publicCases: readonly EvalCaseLike[];
  externalDatasets?: Partial<Record<EvalDatasetVisibility, readonly EvalCaseLike[]>>;
}) {
  const problems: string[] = [];
  const definitions = Array.isArray(input.registry.datasets) ? input.registry.datasets : [];
  if (input.registry.schemaVersion !== 1) problems.push('dataset registry schemaVersion 必须为 1');
  if (!input.registry.snapshotManifest) problems.push('dataset registry 缺少 snapshotManifest');
  const ids = definitions.map((item) => item.id);
  if (new Set(ids).size !== ids.length) problems.push('dataset registry 包含重复 dataset id');
  for (const definition of definitions) {
    if (!definition.id || !definition.version) problems.push('dataset 缺少 id/version');
    if (!['public', 'hidden', 'production_replay'].includes(definition.visibility)) {
      problems.push(`${definition.id} visibility 无效`);
    }
    if (!['smoke', 'regression', 'holdout', 'shadow'].includes(definition.split)) {
      problems.push(`${definition.id} split 无效`);
    }
    if (definition.visibility === 'public') {
      if (!definition.path || definition.pathEnv) problems.push(`${definition.id} public dataset 必须声明 path`);
    } else if (!definition.pathEnv || definition.path) {
      problems.push(`${definition.id} 非公开 dataset 只能通过 pathEnv 注入，禁止仓库内明文 path`);
    }
  }

  const publicIds = new Set<string>();
  const publicPromptHashes = new Set<string>();
  for (const testCase of input.publicCases) {
    const id = typeof testCase.id === 'string' ? testCase.id : '';
    const question = typeof testCase.question === 'string' ? testCase.question : '';
    if (!id || !question) problems.push('public dataset 包含缺少 id/question 的 case');
    if (publicIds.has(id)) problems.push(`public dataset case id 重复：${id}`);
    publicIds.add(id);
    publicPromptHashes.add(normalizedPromptHash(question));
  }

  for (const visibility of ['hidden', 'production_replay'] as const) {
    const cases = input.externalDatasets?.[visibility] ?? [];
    const idsForVisibility = new Set<string>();
    for (const testCase of cases) {
      const id = typeof testCase.id === 'string' ? testCase.id : '';
      const question = typeof testCase.question === 'string' ? testCase.question : '';
      if (!id || !question) problems.push(`${visibility} dataset 包含缺少 id/question 的 case`);
      if (publicIds.has(id) || idsForVisibility.has(id)) problems.push(`${visibility} case id 污染或重复：${id}`);
      idsForVisibility.add(id);
      if (publicPromptHashes.has(normalizedPromptHash(question))) {
        problems.push(`${visibility} prompt 与 public dataset 重叠：${id}`);
      }
    }
  }
  return {
    passed: problems.length === 0,
    problems,
    summary: {
      publicCaseCount: input.publicCases.length,
      hiddenCaseCount: input.externalDatasets?.hidden?.length ?? 0,
      productionReplayCaseCount: input.externalDatasets?.production_replay?.length ?? 0,
      publicPromptHashCount: publicPromptHashes.size,
    },
  };
}
