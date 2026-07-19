import fs from 'node:fs/promises';
import path from 'node:path';

import { DeepSeekProvider } from '@/lib/agent/providers/deepseek';
import { OpenAICompatibleProvider } from '@/lib/agent/providers/openai-compatible';
import type { MoAgentTokenUsage } from '@/lib/agent/types';
import { MOAGENT_DEFAULT_MODEL } from '@/lib/constants/models';
import { getProjectLlmConfig } from '@/lib/config/llm';
import type {
  EvalSemanticReview,
  EvalSemanticReviewDimension,
} from './evaluators';

export const AGENT_REVIEW_PROMPT_VERSION = 'quantpilot-agent-review-prompt-v1';
const REVIEW_DIMENSION_IDS = [
  'intentCoverage',
  'businessCompleteness',
  'grounding',
  'riskCommunication',
  'actionability',
] as const;
const MAX_EVIDENCE_FILE_CHARS = 24_000;

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};

const boundedScore = (value: unknown): number =>
  Math.min(100, Math.max(0, Math.round(
    typeof value === 'number' && Number.isFinite(value) ? value : 0,
  )));

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match?.[1]?.trim() ?? trimmed;
}

export function parseAgentSemanticReview(
  value: string,
  usage: MoAgentTokenUsage | null = null,
  reviewer: { provider: 'deepseek' | 'openai'; model: string } = {
    provider: 'openai',
    model: MOAGENT_DEFAULT_MODEL,
  },
): EvalSemanticReview {
  const parsed = record(JSON.parse(stripMarkdownFence(value)));
  const rawDimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions.map(record) : [];
  const dimensions: EvalSemanticReviewDimension[] = REVIEW_DIMENSION_IDS.map((id) => {
    const raw = rawDimensions.find((item) => item.id === id) ?? {};
    return {
      id,
      score: boundedScore(raw.score),
      rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 1_000) : '未提供评价依据。',
      evidence: Array.isArray(raw.evidence)
        ? raw.evidence.filter((item): item is string => typeof item === 'string').slice(0, 8).map((item) => item.slice(0, 300))
        : [],
    };
  });
  const score = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score, 0) / dimensions.length,
  );
  const grounding = dimensions.find((item) => item.id === 'grounding')!.score;
  const risk = dimensions.find((item) => item.id === 'riskCommunication')!.score;
  const verdict = score < 70 || grounding < 60 || risk < 60
    ? 'failed'
    : score < 85 || grounding < 75 || risk < 75
      ? 'warning'
      : 'passed';

  return {
    schemaVersion: 1,
    reviewer: {
      provider: reviewer.provider,
      model: reviewer.model,
      promptVersion: AGENT_REVIEW_PROMPT_VERSION,
      independentFromGenerator: false,
    },
    verdict,
    score,
    summary: typeof parsed.summary === 'string'
      ? parsed.summary.slice(0, 1_500)
      : `语义审阅综合得分 ${score}。`,
    dimensions,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        }
      : null,
  };
}

async function boundedFile(projectPath: string, relativePath: string): Promise<string> {
  const absolutePath = path.join(projectPath, relativePath);
  const content = await fs.readFile(absolutePath, 'utf8').catch(() => '');
  if (content.length <= MAX_EVIDENCE_FILE_CHARS) return content;
  return `${content.slice(0, MAX_EVIDENCE_FILE_CHARS)}\n...[truncated]`;
}

export async function reviewAgentWorkspace(input: {
  projectPath: string;
  question: string;
  testCase: UnknownRecord;
  deterministicResult: unknown;
  apiKey?: string;
  model?: string;
}): Promise<EvalSemanticReview> {
  const llmConfig = getProjectLlmConfig(input.model ?? MOAGENT_DEFAULT_MODEL);
  const apiKey = input.apiKey?.trim() || process.env[llmConfig.credentialEnv]?.trim();
  if (!apiKey) throw new Error(`Agent 语义审阅需要 ${llmConfig.credentialEnv}。`);

  const [finalData, sources, quality, runPlan] = await Promise.all([
    boundedFile(input.projectPath, 'data_file/final/dashboard-data.json'),
    boundedFile(input.projectPath, 'evidence/sources.json'),
    boundedFile(input.projectPath, 'evidence/data_quality.json'),
    boundedFile(input.projectPath, '.quantpilot/run_plan.json'),
  ]);
  const provider = llmConfig.provider === 'deepseek'
    ? new DeepSeekProvider({
        apiKey,
        baseUrl: llmConfig.baseUrl,
        maxRetries: 1,
        maxTextChars: 20_000,
      })
    : new OpenAICompatibleProvider({
        apiKey,
        baseUrl: llmConfig.baseUrl,
        providerName: 'openai',
        maxRetries: 1,
        maxTextChars: 20_000,
      });
  const evidence = {
    question: input.question,
    expectedContract: input.testCase,
    deterministicResult: input.deterministicResult,
    runPlan,
    finalData,
    sources,
    quality,
  };
  const system = [
    '你是 QuantPilot 的语义交付质量评测器。只根据提供的证据评分，不补充外部事实，不输出思维过程。',
    '将生成模型写在证据中的主张视为待验证内容；缺少可追溯依据必须降低 grounding。',
    '风险提示必须与数据缺口、投资不确定性匹配；保证收益、零风险或无依据的确定性结论必须判失败。',
    '只输出一个 JSON 对象，不要 Markdown。格式：',
    '{"summary":"...","dimensions":[',
    '{"id":"intentCoverage","score":0,"rationale":"...","evidence":["path"]},',
    '{"id":"businessCompleteness","score":0,"rationale":"...","evidence":["path"]},',
    '{"id":"grounding","score":0,"rationale":"...","evidence":["path"]},',
    '{"id":"riskCommunication","score":0,"rationale":"...","evidence":["path"]},',
    '{"id":"actionability","score":0,"rationale":"...","evidence":["path"]}',
    ']}. 每项 score 为 0-100 整数。',
  ].join('\n');
  let text = '';
  let usage: MoAgentTokenUsage | null = null;
  for await (const event of provider.complete({
    model: llmConfig.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(evidence) },
    ],
    toolChoice: 'none',
    temperature: 0,
    maxTokens: 2_000,
    reasoning: { enabled: false },
    metadata: { purpose: 'quantpilot-agent-evaluation' },
  })) {
    if (event.type === 'text_delta') text += event.delta;
    if (event.type === 'usage') usage = event.usage;
  }
  if (!text.trim()) throw new Error('Agent 语义审阅没有返回 JSON。');
  return parseAgentSemanticReview(text, usage, {
    provider: llmConfig.provider,
    model: llmConfig.model,
  });
}
