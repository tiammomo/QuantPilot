import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createMessage } from "@/lib/services/message";
import { streamManager } from "@/lib/services/stream";
import { serializeMessage } from "@/lib/serializers/chat";
import type { writeInitialRunPlan } from "@/lib/domains/finance/workspace";

export class QuantPreparationError extends Error {
  constructor(
    readonly code:
      | "SYMBOL_RESOLVER_UNAVAILABLE"
      | "QUANT_ARTIFACT_PREPARATION_FAILED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "QuantPreparationError";
  }
}

export async function loadQuantValidation() {
  return import("@/lib/quant/validation");
}

export async function ensureQuantDashboardTemplateForAct(projectPath: string) {
  const { ensureQuantDashboardTemplate } = await import("@/lib/utils/scaffold");
  return ensureQuantDashboardTemplate(projectPath);
}

const REQUIRED_AGENT_INPUT_ARTIFACTS = [
  "data_file/final/dashboard-data.json",
  "evidence/sources.json",
  "evidence/data_quality.json",
] as const;

export async function missingAgentInputArtifacts(
  projectPath: string,
): Promise<string[]> {
  const checks = await Promise.all(
    REQUIRED_AGENT_INPUT_ARTIFACTS.map(async (relativePath) => {
      try {
        const stat = await fs.stat(
          path.join(/* turbopackIgnore: true */ projectPath, relativePath),
        );
        return stat.isFile() && stat.size > 2 ? null : relativePath;
      } catch {
        return relativePath;
      }
    }),
  );
  return checks.flatMap((value) => (value === null ? [] : [value]));
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || "./data/projects";
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      /* turbopackIgnore: true */ PROJECTS_DIR,
    );

export function resolveProjectRoot(
  projectId: string,
  repoPath?: string | null,
): string {
  if (repoPath) {
    return path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(
          /* turbopackIgnore: true */ process.cwd(),
          /* turbopackIgnore: true */ repoPath,
        );
  }
  return path.join(
    /* turbopackIgnore: true */ PROJECTS_DIR_ABSOLUTE,
    projectId,
  );
}

export function canUsePrefetchedSelectionDashboard(params: {
  instruction: string;
  runPlan: Awaited<ReturnType<typeof writeInitialRunPlan>>;
  prefetchSkipped: boolean;
}): boolean {
  if (params.prefetchSkipped) {
    return false;
  }
  const normalized = params.instruction.replace(/\s+/g, "");
  return (
    params.runPlan.visualization?.templateId === "stock-selection" &&
    params.runPlan.symbols.length === 0 &&
    /(?:股票|个股|A股|全A|股票池)/.test(normalized) &&
    /全A|A股股票池|股票池|选股|筛选|候选|短线候选|次日|明日|明天|今日|今天|要买|买股|买入策略|短线|推荐\d*(?:只|个)?(?:股票|个股)|(?:股票|个股).{0,12}推荐|推荐.{0,18}(?:股票|个股)/.test(
      normalized,
    )
  );
}

function quantPipelineToolAction(toolName: string) {
  return toolName === "run-planner"
    ? "Generated"
    : toolName === "dashboard-visualization"
      ? "Created"
      : "Read";
}

function stringifyQuantPipelineToolDetail(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function publishQuantPipelineToolStart(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  toolName: string;
  summary: string;
  target?: string;
  input?: unknown;
}): Promise<string> {
  const toolCallId = `quant-pipeline-${randomUUID()}`;
  const metadata = {
    toolName: params.toolName,
    tool_name: params.toolName,
    toolCallId,
    tool_call_id: toolCallId,
    action: quantPipelineToolAction(params.toolName),
    success: true,
    resultStatus: "running",
    summary: params.summary,
    isTransientToolMessage: true,
    ...(params.target
      ? { target: params.target, filePath: params.target }
      : {}),
    ...(params.input !== undefined
      ? {
          toolInput: params.input,
          tool_input: params.input,
          input: params.input,
        }
      : {}),
    isQuantPilotPipelineStep: true,
  };
  const message = await createMessage({
    projectId: params.projectId,
    role: "assistant",
    messageType: "tool_use",
    content: params.summary,
    conversationId: params.conversationId ?? undefined,
    cliSource: params.cliSource ?? undefined,
    metadata,
    requestId: params.requestId,
  });
  streamManager.publish(params.projectId, {
    type: "message",
    data: serializeMessage(message, { requestId: params.requestId }),
  });
  return toolCallId;
}

export async function publishQuantPipelineToolMessage(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  toolName: string;
  summary: string;
  target?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
  success?: boolean;
  resultStatus?: "completed" | "failed" | "skipped";
}) {
  const success = params.success !== false;
  const resultStatus =
    params.resultStatus ?? (success ? "completed" : "failed");
  const metadata = {
    toolName: params.toolName,
    tool_name: params.toolName,
    ...(params.toolCallId
      ? { toolCallId: params.toolCallId, tool_call_id: params.toolCallId }
      : {}),
    action: quantPipelineToolAction(params.toolName),
    success,
    resultStatus,
    summary: params.summary,
    isTransientToolMessage: false,
    ...(params.target
      ? {
          target: params.target,
          filePath: params.target,
        }
      : {}),
    ...(params.input !== undefined
      ? {
          toolInput: params.input,
          tool_input: params.input,
          input: params.input,
        }
      : {}),
    ...(params.output !== undefined
      ? {
          toolOutput: stringifyQuantPipelineToolDetail(params.output),
          tool_output: stringifyQuantPipelineToolDetail(params.output),
          output: stringifyQuantPipelineToolDetail(params.output),
        }
      : {}),
    isQuantPilotPipelineStep: true,
  };

  const message = await createMessage({
    projectId: params.projectId,
    role: "assistant",
    messageType: "tool_result",
    content: params.summary,
    conversationId: params.conversationId ?? undefined,
    cliSource: params.cliSource ?? undefined,
    metadata,
    requestId: params.requestId,
  });

  streamManager.publish(params.projectId, {
    type: "message",
    data: serializeMessage(message, { requestId: params.requestId }),
  });

  return message;
}
