import { NextResponse } from "next/server";

import { collectMoAgentTurnMetrics } from "@/lib/services/moagent-turn-metrics";
import { createMessage } from "@/lib/services/message";
import { serializeMessage } from "@/lib/serializers/chat";
import { streamManager } from "@/lib/services/stream";
import {
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  isUserRequestCancelled,
} from "@/lib/services/user-requests";
import {
  recordQuotaUsage,
  releaseQuotaReservation,
  reserveQuota,
  settleQuotaReservation,
} from "@/lib/quota";
import {
  readQuantRunPlan,
  writeInitialRunPlan,
  type QuantRunPlan,
} from "@/lib/domains/finance/workspace";
import { prefetchQuantDataForRunPlan } from "@/lib/quant/data-prefetch";
import { getQuantCapability } from "@/lib/domains/finance/capabilities";
import type { WorkspaceProgressPublisher } from "@/lib/quant/workspace-progress";
import { buildQuantClarificationMessage } from "@/lib/domains/finance/intent";
import {
  startQuantGenerationRun,
  updateQuantGenerationStep,
} from "@/lib/quant/generation-state";
import { runQuantGenerationStage } from "@/lib/quant/generation-queue";
import {
  createQuantMoAgentMission,
  markQuantMoAgentMissionNode,
  type MoAgentMissionContext,
} from "@/lib/services/moagent-mission-control";
import {
  failMoAgentMission,
  MoAgentMissionStateError,
} from "@/lib/services/moagent-mission-store";
import {
  prepareGovernedKnowledge,
  writeGovernedKnowledgeEvidence,
  type GovernedKnowledgePreparation,
} from "@/lib/platform/knowledge";
import { getProjectIntegrationScope } from "@/lib/platform/context/integration-scope";
import {
  QuantPreparationError,
  canUsePrefetchedSelectionDashboard,
  ensureQuantDashboardTemplateForAct,
  missingAgentInputArtifacts,
  publishQuantPipelineToolMessage,
  publishQuantPipelineToolStart,
} from "@/lib/quant/chat-act-support";

export interface FinanceActPreparationInput {
  projectId: string;
  projectPath: string;
  requestId: string;
  finalInstruction: string;
  effectiveInstruction: string;
  effectiveDisplayInstruction: string;
  isInitialPrompt: boolean;
  cliPreference: string;
  selectedModel: string;
  conversationId: string | null;
  quantCapabilityId?: string | null;
  quantCapabilitySource?: string | null;
  processedImageCount: number;
  previousRunPlan: QuantRunPlan | null;
  quotaActorUserId: string | null;
  userMessageId: string;
  relatedAgentRequestIds: ReadonlySet<string>;
  publishWorkspaceProgress: WorkspaceProgressPublisher;
}

export interface FinanceActPreparationResult {
  response: NextResponse | null;
  missionContext: MoAgentMissionContext | null;
  usePrefetchedSelectionDashboard: boolean;
  governedKnowledgePreparation: GovernedKnowledgePreparation | null;
  governedKnowledgeTaskCategory: string;
}

export async function prepareFinanceActGeneration(
  input: FinanceActPreparationInput,
): Promise<FinanceActPreparationResult> {
  const {
    projectId: project_id,
    projectPath,
    requestId,
    finalInstruction,
    effectiveInstruction,
    effectiveDisplayInstruction,
    isInitialPrompt,
    cliPreference,
    selectedModel,
    conversationId,
    quantCapabilityId,
    quantCapabilitySource,
    processedImageCount,
    previousRunPlan,
    quotaActorUserId,
    userMessageId,
    relatedAgentRequestIds,
    publishWorkspaceProgress,
  } = input;
  let usePrefetchedSelectionDashboard = false;
  let missionContext: MoAgentMissionContext | null = null;
  const projectIntegrationScope = getProjectIntegrationScope(project_id);
  let governedKnowledgePreparation: GovernedKnowledgePreparation | null = null;
  let governedKnowledgeTaskCategory = "quant-research";

  const clarificationResponse = await runQuantGenerationStage({
    projectPath,
    projectId: project_id,
    requestId,
    stage: "planning_data_prefetch",
    lockWorkspace: true,
    task: async () => {
      const generationState = await startQuantGenerationRun({
        projectPath,
        projectId: project_id,
        requestId,
        instruction: finalInstruction,
        cliPreference,
        selectedModel,
      });
      if (
        generationState.status === "cancelled" ||
        (await isUserRequestCancelled(project_id, requestId))
      ) {
        await publishWorkspaceProgress({
          stage: 5,
          cancelledReason: "请求在规划开始前已暂停。",
        });
        return NextResponse.json({
          success: true,
          status: "cancelled",
          message: "Generation request was cancelled before planning",
          requestId,
          userMessageId: userMessageId,
          conversationId: conversationId ?? null,
        });
      }
      let queryRewriteToolCallId: string | undefined;
      let runPlannerToolCallId: string | undefined;
      let dataRegistryToolCallId: string | undefined;
      let marketDataToolCallId: string | undefined;
      let dashboardVisualizationToolCallId: string | undefined;
      let queryRewriteQuotaReservationId: string | null = null;
      try {
        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "planning",
          status: "running",
          summary: "开始生成 run plan。",
        });
        const planningInstruction =
          effectiveDisplayInstruction &&
          effectiveDisplayInstruction.trim().length > 0
            ? effectiveDisplayInstruction.trim()
            : effectiveInstruction;
        queryRewriteToolCallId = await publishQuantPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "query-rewrite",
          target: ".data-agent/finance-query-rewrite.json",
          summary: "正在把用户问题整理为可执行的标的、周期和分析合同。",
          input: {
            question: planningInstruction,
            requestedCapabilityId: quantCapabilityId,
          },
        });
        runPlannerToolCallId = await publishQuantPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "run-planner",
          target: ".data-agent/finance-run-plan.json",
          summary: "正在核对分析对象、时间范围、数据需求和验收规则。",
          input: {
            question: planningInstruction,
            requestedCapabilityId: quantCapabilityId,
          },
        });
        if (quotaActorUserId) {
          const queryRewriteQuota = await reserveQuota({
            actorUserId: quotaActorUserId,
            projectId: project_id,
            metric: "query_rewrite.llm.daily",
            quantity: 1,
            idempotencyKey: `chat-query-rewrite:${quotaActorUserId}:${requestId}:reservation`,
          });
          queryRewriteQuotaReservationId =
            queryRewriteQuota.reservation?.id ?? null;
        }
        const runPlan = await writeInitialRunPlan({
          projectId: project_id,
          projectPath,
          instruction: planningInstruction,
          requestId,
          capabilityId: quantCapabilityId,
          capabilitySource: quantCapabilitySource,
          hasImageAttachments: processedImageCount > 0,
          previousPlan: previousRunPlan,
          llmModel: selectedModel,
        });

        const queryRewriteUsage = runPlan.queryRewrite?.execution.llm.usage;
        if (quotaActorUserId && queryRewriteQuotaReservationId) {
          await settleQuotaReservation({
            reservationId: queryRewriteQuotaReservationId,
            actualQuantity: runPlan.queryRewrite?.execution.llm.attempted
              ? 1
              : 0,
            sourceType: "query_rewrite",
            sourceId: requestId,
            usageEventIdempotencyKey: `chat-query-rewrite:${quotaActorUserId}:${requestId}:request`,
            metadata: {
              status:
                runPlan.queryRewrite?.execution.llm.status ?? "not_attempted",
              strategy:
                runPlan.queryRewrite?.execution.strategy ?? "deterministic",
            },
          });
          queryRewriteQuotaReservationId = null;
        }
        if (
          quotaActorUserId &&
          runPlan.queryRewrite?.execution.llm.attempted &&
          queryRewriteUsage &&
          queryRewriteUsage.totalTokens > 0
        ) {
          const actorId = quotaActorUserId;
          await recordQuotaUsage({
            actorUserId: actorId,
            projectId: project_id,
            metric: "llm.total_tokens.monthly",
            quantity: queryRewriteUsage.totalTokens,
            idempotencyKey: `chat-query-rewrite:${actorId}:${requestId}:tokens`,
            sourceType: "query_rewrite",
            sourceId: requestId,
            metadata: {
              provider: runPlan.queryRewrite.execution.llm.provider,
              model: runPlan.queryRewrite.execution.llm.model,
              inputTokens: queryRewriteUsage.inputTokens,
              outputTokens: queryRewriteUsage.outputTokens,
            },
          }).catch((error) => {
            console.error(
              "[Quota] Failed to record chat Query Rewrite token usage:",
              error,
            );
          });
        }

        await publishQuantPipelineToolMessage({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "query-rewrite",
          toolCallId: queryRewriteToolCallId,
          target: ".data-agent/finance-query-rewrite.json",
          summary:
            runPlan.queryRewrite?.status === "refused"
              ? "问题改写完成，安全策略已阻止确定性收益承诺。"
              : runPlan.queryRewrite?.status === "ready"
                ? `问题改写完成，已解析 ${runPlan.queryRewrite.resolvedSymbols.length} 个标的${runPlan.queryRewrite.execution.llm.applied ? "，并完成 LLM 语义增强" : ""}。`
                : "问题改写完成，存在需要确认的标的或输入。",
          input: { question: planningInstruction },
          output: runPlan.queryRewrite ?? {},
        });
        queryRewriteToolCallId = undefined;

        await publishWorkspaceProgress({ stage: 1, runPlan });
        await publishQuantPipelineToolMessage({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "run-planner",
          toolCallId: runPlannerToolCallId,
          target: ".data-agent/finance-run-plan.json",
          summary:
            runPlan.status === "refused"
              ? "请求触发确定性安全策略，停止进入取数和生成链路。"
              : runPlan.status === "needs_clarification"
                ? "已完成初步识别，发现关键输入仍需澄清。"
                : `生成 ${runPlan.capabilityId} 执行计划，准备进入数据源选择和预取。`,
          input: {
            question: runPlan.question,
            capabilityId: runPlan.capabilityId,
          },
          output: {
            status: runPlan.status,
            templateId: runPlan.visualization?.templateId,
            symbols: runPlan.symbols,
            dataRequirements: runPlan.dataRequirements,
            analysisSteps: runPlan.analysisSteps,
          },
        });
        runPlannerToolCallId = undefined;

        if (runPlan.status === "refused" && runPlan.refusal) {
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "planning",
            status: "warning",
            summary: "请求触发安全策略，未执行取数或生成。",
            runStatus: "refused",
            metadata: {
              code: runPlan.refusal.code,
            },
          });
          const assistantMessage = await createMessage({
            projectId: project_id,
            role: "assistant",
            messageType: "chat",
            content: runPlan.refusal.message,
            conversationId: conversationId ?? undefined,
            cliSource: cliPreference,
            metadata: {
              type: "intent_refusal",
              refusal: runPlan.refusal,
              runPlanPath: ".data-agent/finance-run-plan.json",
              isMissionFinal: true,
              progressStatus: "refused",
            },
            requestId,
          });
          await markUserRequestAsCompleted(project_id, requestId);
          streamManager.publish(project_id, {
            type: "message",
            data: serializeMessage(assistantMessage, { requestId }),
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "intent_refused",
              message: runPlan.refusal.message,
              requestId,
              metadata: { code: runPlan.refusal.code },
            },
          });
          return NextResponse.json({
            success: true,
            status: "intent_refused",
            message: runPlan.refusal.message,
            requestId,
            userMessageId: userMessageId,
            assistantMessageId: assistantMessage.id,
            conversationId: conversationId ?? null,
            refusal: runPlan.refusal,
          });
        }

        if (
          runPlan.status === "needs_clarification" &&
          runPlan.clarification?.required
        ) {
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "planning",
            status: "warning",
            summary: "任务缺少关键输入，需要用户澄清。",
            runStatus: "needs_clarification",
            metadata: {
              missing: runPlan.clarification.missing,
              questions: runPlan.clarification.questions,
            },
          });
          const clarificationContent = buildQuantClarificationMessage(
            runPlan.clarification,
          );
          const turnMetrics = await collectMoAgentTurnMetrics({
            projectId: project_id,
            requestId,
            relatedRequestIds: relatedAgentRequestIds,
          }).catch((error) => {
            console.error(
              "[API] Failed to collect clarification turn metrics:",
              error,
            );
            return null;
          });
          const assistantMessage = await createMessage({
            projectId: project_id,
            role: "assistant",
            messageType: "chat",
            content: clarificationContent,
            conversationId: conversationId ?? undefined,
            cliSource: cliPreference,
            metadata: {
              type: "intent_clarification",
              clarification: runPlan.clarification,
              runPlanPath: ".data-agent/finance-run-plan.json",
              isMissionFinal: true,
              progressStatus: "clarification",
              ...(turnMetrics ? { turnMetrics } : {}),
            },
            requestId,
          });

          await markUserRequestAsCompleted(project_id, requestId);
          streamManager.publish(project_id, {
            type: "message",
            data: serializeMessage(assistantMessage, { requestId }),
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "intent_clarification_required",
              message: "需要补充关键信息后再开始取数和生成看板。",
              requestId,
              metadata: {
                missing: runPlan.clarification.missing,
                questions: runPlan.clarification.questions,
              },
            },
          });

          return NextResponse.json({
            success: true,
            status: "intent_clarification_required",
            message: "Need clarification before agent execution",
            requestId,
            userMessageId: userMessageId,
            assistantMessageId: assistantMessage.id,
            conversationId: conversationId ?? null,
            clarification: runPlan.clarification,
          });
        }

        governedKnowledgePreparation = await prepareGovernedKnowledge({
          requestId,
          scope: projectIntegrationScope,
          task: [
            runPlan.queryRewrite?.rewrittenQuery ?? runPlan.question,
            `capability: ${runPlan.requestedCapabilityId ?? runPlan.capabilityId}`,
            ...runPlan.analysisSteps.slice(0, 12),
          ].join("\n"),
        });
        governedKnowledgeTaskCategory =
          runPlan.requestedCapabilityId ??
          runPlan.capabilityId ??
          "quant-research";
        await writeGovernedKnowledgeEvidence({
          projectPath,
          requestId,
          preparation: governedKnowledgePreparation,
        });
        streamManager.publish(project_id, {
          type: "status",
          data: {
            status: "governed_knowledge_prepared",
            message:
              governedKnowledgePreparation.status === "prepared"
                ? `已取得 ${governedKnowledgePreparation.citationCount} 条受治理知识引用。`
                : governedKnowledgePreparation.status === "empty"
                  ? "受治理知识检索无匹配结果，继续使用真实市场数据。"
                  : governedKnowledgePreparation.status === "unavailable"
                    ? "受治理知识服务当前不可用，已按可选依赖降级。"
                    : "受治理知识集成未启用。",
            requestId,
            metadata: {
              knowledgeStatus: governedKnowledgePreparation.status,
              passageCount: governedKnowledgePreparation.passageCount,
              citationCount: governedKnowledgePreparation.citationCount,
            },
          },
        });

        missionContext = await createQuantMoAgentMission({
          projectId: project_id,
          projectPath,
          requestId,
          objective:
            runPlan.queryRewrite?.rewrittenQuery ?? planningInstruction,
          runPlan,
          maxRepairAttempts: generationState.maxRepairAttempts,
        });

        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "planning",
          status: "success",
          summary: `已生成 ${runPlan.capabilityId} 执行计划。`,
          metadata: {
            capabilityId: runPlan.capabilityId,
            symbols: runPlan.symbols,
            expectedArtifacts: runPlan.expectedArtifacts,
            missionId: missionContext.id,
            generationId: missionContext.generationId,
            missionSpecSha256: missionContext.specHash,
          },
        });
        missionContext = await markQuantMoAgentMissionNode({
          mission: missionContext,
          nodeKey: "planning",
          status: "passed",
        });
        await publishWorkspaceProgress({
          stage: 2,
          runPlan,
          skillIds: Array.from(
            new Set([
              "quant-data-registry",
              ...getQuantCapability(
                runPlan.requestedCapabilityId ?? runPlan.capabilityId,
              ).requiredSkills.filter(
                (skillId) =>
                  skillId !== "run-planner" &&
                  skillId !== "dashboard-visualization" &&
                  (skillId !== "image-extraction" || processedImageCount > 0),
              ),
            ]),
          ),
        });
        dataRegistryToolCallId = await publishQuantPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "quant-data-registry",
          target: "本地数据覆盖与标的解析",
          summary: "正在核验本地数据覆盖、标的解析和可用信源。",
          input: {
            question: runPlan.question,
            templateId: runPlan.visualization?.templateId,
          },
        });
        marketDataToolCallId = await publishQuantPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "quant-market-data",
          target: "data_file/final/dashboard-data.json",
          summary: "正在获取真实行情、历史数据和任务所需指标。",
          input: {
            symbols: runPlan.symbols,
            timeRange: runPlan.timeRange,
          },
        });
        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "data_prefetch",
          status: "running",
          summary: "开始预取真实数据。",
        });
        missionContext = await markQuantMoAgentMissionNode({
          mission: missionContext,
          nodeKey: "data_prefetch",
          status: "running",
        });
        const prefetch = await prefetchQuantDataForRunPlan({
          projectPath,
          plan: runPlan,
        });
        if (quotaActorUserId && !prefetch.skipped) {
          const dataUnits = Math.max(1, prefetch.rawFiles?.length ?? 0);
          await recordQuotaUsage({
            actorUserId: quotaActorUserId,
            projectId: project_id,
            metric: "quant.data_units.daily",
            quantity: dataUnits,
            idempotencyKey: `chat-data-prefetch:${quotaActorUserId}:${requestId}`,
            sourceType: "quant_data_prefetch",
            sourceId: requestId,
            metadata: {
              symbolCount:
                prefetch.symbols?.length ?? (prefetch.symbol ? 1 : 0),
              rawFileCount: prefetch.rawFiles?.length ?? 0,
            },
          }).catch((error) => {
            console.error(
              "[Quota] Failed to record chat data-prefetch usage:",
              error,
            );
          });
        }
        const missingPreparedArtifacts =
          await missingAgentInputArtifacts(projectPath);
        if (
          processedImageCount === 0 &&
          (missingPreparedArtifacts.length > 0 ||
            (isInitialPrompt && prefetch.skipped))
        ) {
          const resolverUnavailable = runPlan.queryRewrite?.issues.find(
            (issue) => issue.code === "SYMBOL_RESOLVER_UNAVAILABLE",
          );
          if (resolverUnavailable) {
            throw new QuantPreparationError(
              "SYMBOL_RESOLVER_UNAVAILABLE",
              `证券标的解析服务暂不可用，平台已停止后续取数：${resolverUnavailable.message}`,
              true,
            );
          }
          throw new QuantPreparationError(
            "QUANT_ARTIFACT_PREPARATION_FAILED",
            `平台数据准备未完成，拒绝启动只具备 UI 创作权限的 MoAgent。${
              missingPreparedArtifacts.length
                ? ` 缺少：${missingPreparedArtifacts.join("、")}。`
                : ""
            } ${prefetch.summary}`.trim(),
            false,
          );
        }
        usePrefetchedSelectionDashboard = canUsePrefetchedSelectionDashboard({
          instruction: effectiveInstruction,
          runPlan,
          prefetchSkipped: prefetch.skipped,
        });
        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "data_prefetch",
          status: prefetch.skipped ? "skipped" : "success",
          summary: prefetch.summary,
          metadata: {
            skipped: prefetch.skipped,
            symbol: prefetch.skipped ? undefined : prefetch.symbol,
            symbols: prefetch.skipped ? undefined : prefetch.symbols,
            finalDataPath: prefetch.skipped
              ? undefined
              : prefetch.finalDataPath,
            rawFiles: prefetch.skipped ? undefined : prefetch.rawFiles,
            deterministicDashboard:
              usePrefetchedSelectionDashboard || undefined,
          },
        });
        missionContext = await markQuantMoAgentMissionNode({
          mission: missionContext,
          nodeKey: "data_prefetch",
          status: prefetch.skipped ? "skipped" : "passed",
        });
        missionContext = await markQuantMoAgentMissionNode({
          mission: missionContext,
          nodeKey: "workspace_generation",
          status: "running",
        });
        if (prefetch.skipped) {
          await publishQuantPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "quant-data-registry",
            toolCallId: dataRegistryToolCallId,
            target: "本地数据预取",
            summary: prefetch.summary,
            output: {
              skipped: true,
              reason: prefetch.summary,
            },
          });
          dataRegistryToolCallId = undefined;
          await publishQuantPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "quant-market-data",
            toolCallId: marketDataToolCallId,
            target: "data_file/final/dashboard-data.json",
            summary: `本阶段未重复获取行情数据：${prefetch.summary}`,
            resultStatus: "skipped",
            output: {
              skipped: true,
              reason: prefetch.summary,
            },
          });
          marketDataToolCallId = undefined;
          await publishWorkspaceProgress({
            stage: 3,
            runPlan,
            skillIds: ["dashboard-visualization"],
          });
        } else {
          const symbols = prefetch.symbols?.length
            ? prefetch.symbols
            : prefetch.symbol
              ? [prefetch.symbol]
              : [];
          const screenerRawFiles =
            prefetch.rawFiles?.filter((file) =>
              file.includes("a-share-screener"),
            ) ?? [];
          const usedScreener = screenerRawFiles.length > 0;
          await publishQuantPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "quant-data-registry",
            toolCallId: dataRegistryToolCallId,
            target: usedScreener
              ? "/api/v1/research/screeners/a-share/short-term-candidates"
              : "/api/v1/symbols/resolve",
            summary: usedScreener
              ? symbols.length
                ? `调用本地选股接口，得到候选标的：${symbols.join("、")}。`
                : "调用本地选股接口并完成候选筛选。"
              : symbols.length
                ? `解析用户问题中的标的并确认代码：${symbols.join("、")}。`
                : "完成标的解析与本地数据能力检查。",
            input: {
              question: runPlan.question,
              templateId: runPlan.visualization?.templateId,
            },
            output: {
              symbols,
              rawFiles: usedScreener ? screenerRawFiles : prefetch.rawFiles,
            },
          });
          dataRegistryToolCallId = undefined;
          await publishQuantPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "quant-market-data",
            toolCallId: marketDataToolCallId,
            target: "data_file/final/dashboard-data.json",
            summary: prefetch.summary,
            input: {
              endpoints: [
                "/api/v1/quotes/realtime",
                "/api/v1/quotes/history/{symbol}",
                "/api/v1/indicators/technical/{symbol}",
                "/api/v1/fundamentals/financials/{symbol}",
              ],
              symbols,
            },
            output: {
              finalDataPath: prefetch.finalDataPath,
              rawFiles: prefetch.rawFiles,
            },
          });
          marketDataToolCallId = undefined;
          await publishWorkspaceProgress({
            stage: 3,
            runPlan,
            skillIds: ["dashboard-visualization"],
          });
          if (usePrefetchedSelectionDashboard) {
            dashboardVisualizationToolCallId =
              await publishQuantPipelineToolStart({
                projectId: project_id,
                requestId,
                conversationId,
                cliSource: cliPreference,
                toolName: "dashboard-visualization",
                target: "app/page.tsx",
                summary: "正在基于本地选股数据生成标准选股工作区。",
                input: {
                  templateId: "stock-selection",
                  variantId: runPlan.visualization?.variantId,
                  symbols,
                },
              });
          }
          await ensureQuantDashboardTemplateForAct(projectPath);
          if (usePrefetchedSelectionDashboard) {
            await publishQuantPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              toolName: "dashboard-visualization",
              toolCallId: dashboardVisualizationToolCallId,
              target: "app/page.tsx",
              summary:
                "平台已基于本地选股数据生成标准选股看板，后续直接进入自动验证。",
              input: {
                templateId: "stock-selection",
                variantId: runPlan.visualization?.variantId,
                symbols,
              },
              output: {
                finalDataPath: prefetch.finalDataPath,
                deterministicDashboard: true,
              },
            });
            dashboardVisualizationToolCallId = undefined;
          }
        }
        if (!prefetch.skipped) {
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "quant_data_prefetched",
              message: prefetch.summary,
              requestId,
              metadata: {
                symbol: prefetch.symbol,
                finalDataPath: prefetch.finalDataPath,
                rawFiles: prefetch.rawFiles,
              },
            },
          });
        }
      } catch (error) {
        if (queryRewriteQuotaReservationId) {
          await releaseQuotaReservation({
            reservationId: queryRewriteQuotaReservationId,
          }).catch((releaseError) => {
            console.error(
              "[Quota] Failed to release Query Rewrite reservation:",
              releaseError,
            );
          });
          queryRewriteQuotaReservationId = null;
        }
        console.error(
          "[API] Failed to prepare QuantPilot run plan or data prefetch:",
          error,
        );
        const preparationMessage =
          error instanceof Error ? error.message : String(error);
        const typedPreparationError =
          error instanceof QuantPreparationError ? error : null;
        const pendingToolFailures = [
          queryRewriteToolCallId
            ? {
                toolName: "query-rewrite",
                toolCallId: queryRewriteToolCallId,
                target: ".data-agent/finance-query-rewrite.json",
              }
            : null,
          runPlannerToolCallId
            ? {
                toolName: "run-planner",
                toolCallId: runPlannerToolCallId,
                target: ".data-agent/finance-run-plan.json",
              }
            : null,
          dataRegistryToolCallId
            ? {
                toolName: "quant-data-registry",
                toolCallId: dataRegistryToolCallId,
                target: "本地数据覆盖与标的解析",
              }
            : null,
          marketDataToolCallId
            ? {
                toolName: "quant-market-data",
                toolCallId: marketDataToolCallId,
                target: "data_file/final/dashboard-data.json",
              }
            : null,
          dashboardVisualizationToolCallId
            ? {
                toolName: "dashboard-visualization",
                toolCallId: dashboardVisualizationToolCallId,
                target: "app/page.tsx",
              }
            : null,
        ].filter((value): value is NonNullable<typeof value> => value !== null);
        await Promise.all(
          pendingToolFailures.map((pending) =>
            publishQuantPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              ...pending,
              summary: `本阶段未完成：${preparationMessage}`,
              success: false,
              resultStatus: "failed",
              output: { error: preparationMessage },
            }).catch((projectionError) => {
              console.error(
                `[API] Failed to settle ${pending.toolName} projection:`,
                projectionError,
              );
            }),
          ),
        );
        const missionProjectBusy =
          error instanceof MoAgentMissionStateError &&
          error.code === "MISSION_PROJECT_BUSY";
        if (missionContext) {
          await failMoAgentMission({
            missionId: missionContext.id,
            projectId: missionContext.projectId,
            requestId: missionContext.requestId,
            code: "MISSION_PREPARATION_FAILED",
            message: preparationMessage,
          });
        }
        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "data_prefetch",
          status: "failed",
          summary: "生成计划或数据预取失败。",
          runStatus: "failed",
          errorMessage: preparationMessage,
        });
        await markUserRequestAsFailed(
          project_id,
          requestId,
          preparationMessage,
        );
        await publishWorkspaceProgress({
          stage: 5,
          failureReason: preparationMessage,
        });
        streamManager.publish(project_id, {
          type: "status",
          data: {
            status: "quant_data_preparation_failed",
            message: preparationMessage,
            requestId,
            metadata: {
              terminalFailure: true,
              errorCode: missionProjectBusy
                ? "MISSION_PROJECT_BUSY"
                : (typedPreparationError?.code ??
                  "QUANT_DATA_PREPARATION_FAILED"),
              retryable: typedPreparationError?.retryable ?? false,
              agentExecutionSkipped: true,
            },
          },
        });
        return NextResponse.json(
          {
            success: false,
            error: missionProjectBusy
              ? "MISSION_PROJECT_BUSY"
              : (typedPreparationError?.code ??
                "QUANT_DATA_PREPARATION_FAILED"),
            message: preparationMessage,
            retryable: typedPreparationError?.retryable ?? false,
            requestId,
          },
          { status: missionProjectBusy ? 409 : 503 },
        );
      }
      return null;
    },
  });
  if (clarificationResponse) {
    return {
      response: clarificationResponse,
      missionContext,
      usePrefetchedSelectionDashboard,
      governedKnowledgePreparation,
      governedKnowledgeTaskCategory,
    };
  }

  return {
    response: clarificationResponse,
    missionContext,
    usePrefetchedSelectionDashboard,
    governedKnowledgePreparation,
    governedKnowledgeTaskCategory,
  };
}
