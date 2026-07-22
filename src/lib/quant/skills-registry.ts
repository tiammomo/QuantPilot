import fs from 'fs/promises';
import path from 'path';

export type QuantSkillStatus = 'stable' | 'planned' | 'deprecated';
export type QuantSkillScope = 'workflow' | 'quant' | 'input' | 'evidence' | 'platform' | 'visualization';

export interface QuantCoreSkill {
  id: string;
  name: string;
  version: string;
  status: QuantSkillStatus;
  scope?: QuantSkillScope;
  boundary: string;
  inputs?: string[];
  outputs?: string[];
  scripts?: string[];
  references?: string[];
  endpoints?: string[];
  validation?: string[];
}

export interface QuantSkillsRegistry {
  schemaVersion: 1;
  policy: {
    targetCoreSkillCount: number;
    packageFormat?: 'tgz';
    packageDir?: string;
    description: string;
  };
  coreSkills: QuantCoreSkill[];
}

const REGISTRY_PATH = path.join(process.cwd(), '.moagent', 'skills.registry.json');

const FALLBACK_CORE_SKILLS: QuantCoreSkill[] = [
  {
    id: 'query-rewrite',
    name: '问题改写',
    version: '0.1.0',
    status: 'stable',
    scope: 'workflow',
    boundary: '把自然语言问题规范化为标的、周期、分析重点和澄清状态。',
  },
  {
    id: 'run-planner',
    name: '运行规划',
    version: '0.1.0',
    status: 'stable',
    scope: 'workflow',
    boundary: '意图澄清、任务拆解和 run_plan 生成。',
  },
  {
    id: 'quant-data-registry',
    name: '数据注册与信源选择',
    version: '0.1.0',
    status: 'stable',
    scope: 'quant',
    boundary: '查询后端数据能力和信源选择。',
  },
  {
    id: 'quant-symbol-resolver',
    name: '标的解析',
    version: '0.1.0',
    status: 'stable',
    scope: 'quant',
    boundary: '把名称和代码解析为标准证券标识。',
  },
  {
    id: 'quant-market-data',
    name: '行情数据',
    version: '0.1.0',
    status: 'stable',
    scope: 'quant',
    boundary: '实时行情、K 线和指数/ETF 数据。',
  },
  {
    id: 'data-quality',
    name: '数据质量',
    version: '0.1.0',
    status: 'stable',
    scope: 'evidence',
    boundary: '生成来源、质量和限制证据。',
  },
  {
    id: 'dashboard-visualization',
    name: '可视化看板',
    version: '0.1.0',
    status: 'stable',
    scope: 'visualization',
    boundary: '基于 final 数据生成 Next.js 看板。',
  },
];

const FALLBACK_REGISTRY: QuantSkillsRegistry = {
  schemaVersion: 1,
  policy: {
    targetCoreSkillCount: 11,
    packageFormat: 'tgz',
    packageDir: '.moagent/skill-packages',
    description: 'Fallback QuantPilot skills registry.',
  },
  coreSkills: FALLBACK_CORE_SKILLS,
};

let cachedRegistry: { mtimeMs: number; value: QuantSkillsRegistry } | null = null;

function asRegistry(value: unknown): QuantSkillsRegistry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const registry = value as QuantSkillsRegistry;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.coreSkills)) {
    return null;
  }

  return registry;
}

export async function readQuantSkillsRegistry(): Promise<QuantSkillsRegistry> {
  try {
    const stat = await fs.stat(REGISTRY_PATH);
    if (cachedRegistry?.mtimeMs === stat.mtimeMs) {
      return cachedRegistry.value;
    }
    const content = await fs.readFile(REGISTRY_PATH, 'utf8');
    const parsed = asRegistry(JSON.parse(content));
    if (!parsed) {
      throw new Error('registry schema is invalid');
    }
    cachedRegistry = { mtimeMs: stat.mtimeMs, value: parsed };
    return parsed;
  } catch (error) {
    if (process.env.QUANTPILOT_ALLOW_SKILLS_REGISTRY_FALLBACK === '1') {
      return FALLBACK_REGISTRY;
    }
    throw new Error(
      `Skills registry 不可用，已按 fail-closed 策略停止运行：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getCoreQuantSkillIds(registry: QuantSkillsRegistry): string[] {
  return registry.coreSkills.map((skill) => skill.id);
}

export function getDefaultQuantSkillIds(registry: QuantSkillsRegistry): string[] {
  return registry.coreSkills
    .filter((skill) => skill.status === 'stable')
    .map((skill) => skill.id);
}

export function getQuantSkillPackagePath(registry: QuantSkillsRegistry, skillId: string): string {
  const packageDir = registry.policy.packageDir ?? '.moagent/skill-packages';
  return path.join(process.cwd(), packageDir, `${skillId}.tgz`);
}

export function describeQuantSkillsForPrompt(registry: QuantSkillsRegistry): string {
  const coreLines = registry.coreSkills.map((skill) => {
    const scriptText = skill.scripts?.length ? `；脚本：${skill.scripts.join(', ')}` : '';
    const referenceText = skill.references?.length ? `；参考：${skill.references.join(', ')}` : '';
    return `- ${skill.id}（${skill.name}，${skill.status}，v${skill.version}）：${skill.boundary}${scriptText}${referenceText}`;
  });

  return [
    'QuantPilot skills 治理：',
    `- 目标核心 skill 数量：${registry.policy.targetCoreSkillCount}`,
    `- 规则：${registry.policy.description}`,
    ...coreLines,
  ].join('\n');
}
