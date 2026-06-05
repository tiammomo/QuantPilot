/**
 * Travel-only chat action endpoint.
 *
 * The route never falls back to the legacy QuantPilot/CLI generation flow.
 * Database writes are best-effort so local demos still work when Postgres is
 * not running.
 */

import fs from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { createMessage } from '@/lib/services/message';
import { getProjectById, updateProjectActivity } from '@/lib/services/project';
import { streamManager } from '@/lib/services/stream';
import { markUserRequestAsCompleted, upsertUserRequest } from '@/lib/services/user-requests';
import { serializeMessage } from '@/lib/serializers/chat';
import { generateProjectId } from '@/lib/utils';
import type { ChatActRequest } from '@/types/backend';
import { warmTravelData } from '@/lib/travel/planner';
import { executeTravelPlanningSession, type TravelPlanningSessionState } from '@/lib/travel/orchestration';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

type TravelProgressStage =
  | 'received'
  | 'parsing'
  | 'retrieving_poi'
  | 'planning'
  | 'writing_artifacts'
  | 'rendering'
  | 'completed';

const TRAVEL_PROGRESS_LABELS: Record<TravelProgressStage, string> = {
  received: '旅游规划任务已收到，正在启动北京路线规划链路。',
  parsing: '已识别本轮游玩目标和约束。',
  retrieving_poi: '正在读取本地北京 POI/UGC 数据并筛选候选点。',
  planning: '正在生成或调整可执行路线方案。',
  writing_artifacts: '正在写入 itinerary-data.json 和证据文件。',
  rendering: '已更新右侧“北京智能路线方案”。',
  completed: '北京旅游路线规划完成。',
};

const TRAVEL_CAPABILITY_IDS = new Set([
  'culture_route',
  'mixed_food_route',
  'family_low_queue',
  'budget_route',
  'efficient_route',
  'replan_compare',
]);

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(process.cwd(), PROJECTS_DIR);

function coerceString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveProjectRoot(projectId: string, repoPath?: string | null): string {
  if (repoPath) {
    return path.isAbsolute(repoPath) ? repoPath : path.resolve(process.cwd(), repoPath);
  }
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId);
}

function resolveTravelCapabilityId(value?: string | null): string {
  return value && TRAVEL_CAPABILITY_IDS.has(value) ? value : 'mixed_food_route';
}

function normalizeTravelInstruction(value: string): string {
  return value
    .trim()
    .replace(/^[/\\]+\s*/, '')
    .replace(/^(travel|route|replan|plan)\s*[:：]\s*/i, '')
    .trim();
}

function isTravelAdjustmentText(value: string): boolean {
  return /(预算降到|重新规划|保留|不去|别去|不要去|去掉|排除|避开|取消|删除|替换|换一个|换成|改成|调整|仍然|控制在|添加|加一个|增加|再加|顺路|其他地方不变|午餐不变|午餐地点|吃饭地点)/.test(
    normalizeTravelInstruction(value),
  );
}

function publishTravelProgress(params: {
  projectId: string;
  requestId: string;
  stage: TravelProgressStage;
  startedAt: number;
  conversationId?: string | null;
  final?: boolean;
}) {
  const message = TRAVEL_PROGRESS_LABELS[params.stage];
  const elapsedMs = Math.max(0, Math.round(performance.now() - params.startedAt));
  streamManager.publish(params.projectId, {
    type: 'travel_progress',
    data: { requestId: params.requestId, stage: params.stage, message, elapsed_ms: elapsedMs },
  });
  streamManager.publish(params.projectId, {
    type: 'message',
    data: {
      id: `${params.requestId}-travel-progress-${params.stage}`,
      projectId: params.projectId,
      role: 'assistant',
      messageType: 'chat',
      content: message,
      conversationId: params.conversationId ?? null,
      cliSource: 'local-travel-planner',
      requestId: `${params.requestId}-travel-progress-${params.stage}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isStreaming: !params.final,
      isFinal: Boolean(params.final),
      isOptimistic: true,
      metadata: { type: 'travel_progress', stage: params.stage, elapsed_ms: elapsedMs, localOnly: true },
    },
  });
}

function buildTravelAssistantMessage(result: Record<string, any>): string {
  const planning = result.planning_response || {};
  const proposals = Array.isArray(planning.proposals) ? planning.proposals.slice(0, 3) : [];
  const routePatchSummary = planning.route_patch_summary;
  const lines = ['# 北京旅行规划已生成', '', `目的地：${planning.resolved_area || result.parsed_request?.area || '北京'}`, ''];

  if (routePatchSummary) {
    const kept = Array.isArray(routePatchSummary.kept) ? routePatchSummary.kept.join('、') : '';
    const removed = Array.isArray(routePatchSummary.removed) ? routePatchSummary.removed.join('、') : '';
    const added = Array.isArray(routePatchSummary.added) ? routePatchSummary.added.join('、') : '';
    lines.push('## 本次调整');
    if (kept) lines.push(`- 保留：${kept}`);
    if (removed) lines.push(`- 删除：${removed}`);
    if (added) lines.push(`- 新增：${added}`);
    lines.push('');
  }

  if (planning.natural_language_explanation) {
    lines.push('## 路线说明', String(planning.natural_language_explanation), '');
  }

  if (planning.llm_rerank) {
    lines.push(
      '## 规划依据',
      `- 主推方案：${planning.final_selected_proposal_id ?? planning.llm_rerank.primary_proposal_id ?? '-'}`,
      `- 选择依据：${planning.llm_rerank.rerank_source === 'wiki_local' ? '本地旅行知识与地点证据' : planning.llm_rerank.llm_used ? '你的偏好与路线可执行性' : '本地规划规则'}`,
      planning.llm_rerank.fallback_reason ? `- 注意事项：${planning.llm_rerank.fallback_reason}` : '- 注意事项：暂无硬性风险',
      '',
    );
  }

  if (planning.wiki_retrieval) {
    const hits = Array.isArray(planning.wiki_retrieval.hits) ? planning.wiki_retrieval.hits.slice(0, 5) : [];
    lines.push(
      '## 参考地点',
      ...hits.map((hit: Record<string, any>) => `- ${hit.title || '-'}`),
      '',
    );
  }

  proposals.forEach((proposal: Record<string, any>, index: number) => {
    const names = Array.isArray(proposal.ordered_poi_names) ? proposal.ordered_poi_names.join(' -> ') : '暂无候选 POI';
    const risks = Array.isArray(proposal.risks) && proposal.risks.length > 0 ? proposal.risks.slice(0, 2).join('；') : '未发现硬约束风险';
    const transferSummary = proposal.transfer_source_summary || proposal.quality_summary?.commute || {};
    const commuteEdgesUsed = Number(transferSummary.commute_edges_used || 0);
    const coordinateEstimatesUsed = Number(transferSummary.coordinate_estimates_used || 0);
    lines.push(
      `## 方案 ${index + 1}：${proposal.display_title || proposal.title || proposal.strategy || '路线方案'}`,
      `- 预计总时长：${proposal.total_route_duration_min ?? '-'} 分钟`,
      `- 预计预算：${proposal.total_budget_estimate ?? '-'} 元`,
      `- 预计转移/步行：${proposal.total_transfer_minutes ?? '-'} 分钟，${proposal.total_walking_distance_m ?? '-'} 米`,
      `- 转移估算：${commuteEdgesUsed} 段有本地通勤数据，${coordinateEstimatesUsed} 段按距离估算`,
      `- 路线：${names}`,
      `- 风险：${risks}`,
      '',
    );
  });

  lines.push(
    `数据来源：${planning.generation_metrics?.database_recall_used ? '已使用本地北京旅行数据库' : '已使用本地旅行规划数据'}`,
    '说明：转移时间和排队热度是规划参考，出发前仍建议核对实时交通与景区开放信息。',
  );
  return lines.join('\n');
}

async function writeTravelPlanArtifacts(params: {
  projectPath: string;
  requestId: string;
  capabilityId: string;
  instruction: string;
  result: Record<string, any>;
  agentTrace?: Array<Record<string, any>>;
  sessionState?: TravelPlanningSessionState | null;
}) {
  const travelDir = path.join(params.projectPath, '.travelpilot');
  const finalDir = path.join(params.projectPath, 'data_file', 'final');
  const evidenceDir = path.join(params.projectPath, 'evidence');
  await Promise.all([
    fs.mkdir(travelDir, { recursive: true }),
    fs.mkdir(finalDir, { recursive: true }),
    fs.mkdir(evidenceDir, { recursive: true }),
  ]);

  const now = new Date().toISOString();
  const planning = params.result.planning_response || {};
  await Promise.all([
    fs.writeFile(
      path.join(travelDir, 'run_plan.json'),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          product: 'beijing-travel-agent',
          requestId: params.requestId,
          capabilityId: params.capabilityId,
          status: 'completed',
          instruction: params.instruction,
          artifactPaths: {
            itinerary: 'data_file/final/itinerary-data.json',
            sources: 'evidence/sources.json',
            dataQuality: 'evidence/data_quality.json',
            diagnostics: '.travelpilot/session-state.json',
          },
          createdAt: now,
          updatedAt: now,
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
    fs.writeFile(path.join(finalDir, 'itinerary-data.json'), `${JSON.stringify(params.result, null, 2)}\n`, 'utf8'),
    fs.writeFile(path.join(travelDir, 'agent-trace.json'), `${JSON.stringify(params.agentTrace || [], null, 2)}\n`, 'utf8'),
    fs.writeFile(path.join(travelDir, 'session-state.json'), `${JSON.stringify(params.sessionState || {}, null, 2)}\n`, 'utf8'),
    fs.writeFile(
      path.join(evidenceDir, 'sources.json'),
      `${JSON.stringify(
        {
          generatedAt: now,
          dataSource: 'travel-data/processed',
          evidence: planning.evidence || params.result.evidence || [],
          dataFiles: [
            'beijing_planner_entities.json',
            'beijing_mixed_category_pois.json',
            'beijing_culture_pois.json',
            'beijing_poi_feature_aggregates.json',
            'beijing_review_records.json',
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
    fs.writeFile(
      path.join(evidenceDir, 'data_quality.json'),
      `${JSON.stringify(
        {
          generatedAt: now,
          dataSource: 'travel-data/processed',
          realtimeData: false,
          proposalCount: Array.isArray(planning.proposals) ? planning.proposals.length : 0,
          generationMetrics: planning.generation_metrics || null,
          limitations: [
            '未接入实时地图、实时排队或外部点评 API。',
            '转移时间优先来自 travel_commute_edges 通勤库，缺失路段回退坐标估算；排队风险为本地静态信号。',
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
  ]);
}

async function readExistingTravelItinerary(projectPath: string): Promise<Record<string, any> | null> {
  try {
    const raw = await fs.readFile(path.join(projectPath, 'data_file', 'final', 'itinerary-data.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function saveTravelMessages(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  userContent: string;
  assistantContent: string;
  assistantMetadata?: Record<string, unknown>;
}): Promise<{ userMessageId: string; assistantMessageId: string; persisted: boolean }> {
  try {
    const userMessage = await createMessage({
      projectId: params.projectId,
      role: 'user',
      messageType: 'chat',
      content: params.userContent,
      conversationId: params.conversationId ?? undefined,
      cliSource: 'local-travel-planner',
      requestId: params.requestId,
    });
    const assistantMessage = await createMessage({
      projectId: params.projectId,
      role: 'assistant',
      messageType: 'chat',
      content: params.assistantContent,
      conversationId: params.conversationId ?? undefined,
      cliSource: 'local-travel-planner',
      metadata: params.assistantMetadata,
      requestId: params.requestId,
    });
    streamManager.publish(params.projectId, { type: 'message', data: serializeMessage(userMessage, { requestId: params.requestId }) });
    streamManager.publish(params.projectId, { type: 'message', data: serializeMessage(assistantMessage, { requestId: params.requestId }) });
    return { userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, persisted: true };
  } catch (error) {
    console.warn('[TravelChat] Database unavailable; streaming local-only messages instead.', error);
  }

  const now = new Date().toISOString();
  const userMessageId = `${params.requestId}-user-local`;
  const assistantMessageId = `${params.requestId}-assistant-local`;
  streamManager.publish(params.projectId, {
    type: 'message',
    data: {
      id: userMessageId,
      projectId: params.projectId,
      role: 'user',
      messageType: 'chat',
      content: params.userContent,
      conversationId: params.conversationId ?? null,
      cliSource: 'local-travel-planner',
      requestId: params.requestId,
      createdAt: now,
      updatedAt: now,
      metadata: { localOnly: true },
    },
  });
  streamManager.publish(params.projectId, {
    type: 'message',
    data: {
      id: assistantMessageId,
      projectId: params.projectId,
      role: 'assistant',
      messageType: 'chat',
      content: params.assistantContent,
      conversationId: params.conversationId ?? null,
      cliSource: 'local-travel-planner',
      requestId: params.requestId,
      createdAt: now,
      updatedAt: now,
      metadata: { ...params.assistantMetadata, localOnly: true },
    },
  });
  return { userMessageId, assistantMessageId, persisted: false };
}

function buildImagePreferenceText(images: unknown[]): string {
  if (images.length === 0) return '';
  return `\n\n用户上传了 ${images.length} 张图片附件；当前旅游规划会把图片作为出行偏好、目的地或风格线索。`;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const rawBody = await request.json().catch(() => ({}));
    const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as ChatActRequest & Record<string, unknown>;

    const project = await getProjectById(project_id);
    if (!project) return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });

    const legacyBody = body as Record<string, unknown>;
    const projectPath = resolveProjectRoot(project_id, project.repoPath);
    const rawInstruction = typeof body.instruction === 'string' ? body.instruction : '';
    const displayInstruction = coerceString(body.displayInstruction) ?? coerceString(legacyBody.display_instruction) ?? rawInstruction;
    const conversationId = coerceString(body.conversationId) ?? coerceString(legacyBody.conversation_id);
    const requestId = coerceString(body.requestId) ?? coerceString(legacyBody.request_id) ?? generateProjectId();
    const rawImages = Array.isArray(body.images) ? body.images : [];

    const finalInstruction = `${normalizeTravelInstruction(displayInstruction || rawInstruction)}${buildImagePreferenceText(rawImages)}`.trim();
    if (!finalInstruction) return NextResponse.json({ success: false, error: 'instruction is required' }, { status: 400 });

    await upsertUserRequest({ id: requestId, projectId: project_id, instruction: finalInstruction, cliPreference: 'local-travel-planner' }).catch(() => {});
    await updateProjectActivity(project_id).catch(() => {});

    const legacyCapabilityId = coerceString(body.quantCapabilityId) ?? coerceString(legacyBody.quant_capability_id) ?? coerceString(body.capabilityId) ?? coerceString(legacyBody.capability_id);
    const selectedTravelCapabilityId = resolveTravelCapabilityId(coerceString(body.travelCapabilityId) ?? legacyCapabilityId);
    const existingItinerary = await readExistingTravelItinerary(projectPath);
    const shouldReplan = Boolean(existingItinerary) && isTravelAdjustmentText(finalInstruction);

    const startedAt = performance.now();
    publishTravelProgress({ projectId: project_id, requestId, stage: 'received', startedAt, conversationId });
    publishTravelProgress({ projectId: project_id, requestId, stage: 'parsing', startedAt, conversationId });
    publishTravelProgress({ projectId: project_id, requestId, stage: 'retrieving_poi', startedAt, conversationId });
    await warmTravelData();
    publishTravelProgress({ projectId: project_id, requestId, stage: 'planning', startedAt, conversationId });

    const orchestration = await executeTravelPlanningSession({
      text: finalInstruction,
      requestId,
      existingItinerary: shouldReplan ? existingItinerary : null,
    });

    if (orchestration.status === 'travel_clarification_required') {
      const messages = await saveTravelMessages({
        projectId: project_id,
        requestId,
        conversationId,
        userContent: finalInstruction,
        assistantContent: orchestration.clarification?.message || '需要补充信息后再继续规划。',
        assistantMetadata: {
          type: 'travel_clarification_required',
          reason: orchestration.clarification?.reason,
          sessionStateSummary: orchestration.sessionStateSummary,
          clarificationPayload: orchestration.clarificationPayload,
        },
      });
      await markUserRequestAsCompleted(requestId).catch(() => {});
      streamManager.publish(project_id, {
        type: 'status',
        data: {
          status: 'travel_clarification_required',
          message: orchestration.clarification?.message || '需要补充信息后再继续规划。',
          requestId,
          metadata: {
            reason: orchestration.clarification?.reason,
            sessionStateSummary: orchestration.sessionStateSummary,
            clarificationPayload: orchestration.clarificationPayload,
          },
        },
      });
      return NextResponse.json({
        success: true,
        status: 'travel_clarification_required',
        requestId,
        userMessageId: messages.userMessageId,
        assistantMessageId: messages.assistantMessageId,
        persistedMessages: messages.persisted,
        conversationId: conversationId ?? null,
        message: orchestration.clarification?.message || '需要补充信息后再继续规划。',
        needsClarification: true,
        sessionStateSummary: orchestration.sessionStateSummary,
        clarificationPayload: orchestration.clarificationPayload,
      });
    }

    const travelResult = {
      parsed_request: orchestration.parsed_request || {},
      parser_confidence: orchestration.parser_confidence ?? 0.86,
      parser_notes: orchestration.parser_notes || [],
      parser_correction_hints: orchestration.parser_correction_hints || [],
      planning_response: orchestration.planning_response || {},
      agent_trace: orchestration.agentTrace,
      session_state_summary: orchestration.sessionStateSummary,
    };
    const planningResponse = travelResult.planning_response as Record<string, any>;

    publishTravelProgress({ projectId: project_id, requestId, stage: 'writing_artifacts', startedAt, conversationId });
    await writeTravelPlanArtifacts({
      projectPath,
      requestId,
      capabilityId: selectedTravelCapabilityId,
      instruction: finalInstruction,
      result: travelResult as Record<string, any>,
      agentTrace: orchestration.agentTrace,
      sessionState: orchestration.sessionState,
    });
    publishTravelProgress({ projectId: project_id, requestId, stage: 'rendering', startedAt, conversationId });

    const status = orchestration.status;
    const messages = await saveTravelMessages({
      projectId: project_id,
      requestId,
      conversationId,
      userContent: finalInstruction,
      assistantContent: buildTravelAssistantMessage(travelResult as Record<string, any>),
      assistantMetadata: {
        type: status,
        capabilityId: selectedTravelCapabilityId,
        itineraryPath: 'data_file/final/itinerary-data.json',
        evidencePath: 'evidence/sources.json',
        runPlanPath: '.travelpilot/run_plan.json',
        generationMetrics: planningResponse.generation_metrics,
        replanMetadata: planningResponse.replan_metadata,
        sessionStateSummary: orchestration.sessionStateSummary,
      },
    });
    await markUserRequestAsCompleted(requestId).catch(() => {});

    streamManager.publish(project_id, {
      type: 'status',
      data: {
        status,
        message: status === 'travel_replan_completed' ? '北京旅游路线已基于上一轮结果完成动态重规划。' : '北京旅游路线已基于本地 POI/UGC 数据完成规划。',
        requestId,
        metadata: {
          capabilityId: selectedTravelCapabilityId,
          itineraryPath: 'data_file/final/itinerary-data.json',
          proposalCount: Array.isArray(planningResponse.proposals) ? planningResponse.proposals.length : 0,
          sessionStateSummary: orchestration.sessionStateSummary,
        },
      },
    });
    publishTravelProgress({ projectId: project_id, requestId, stage: 'completed', startedAt, conversationId, final: true });

    return NextResponse.json({
      success: true,
      status,
      requestId,
      userMessageId: messages.userMessageId,
      assistantMessageId: messages.assistantMessageId,
      persistedMessages: messages.persisted,
      conversationId: conversationId ?? null,
      itineraryPath: 'data_file/final/itinerary-data.json',
      proposalCount: Array.isArray(planningResponse.proposals) ? planningResponse.proposals.length : 0,
      travelItinerary: travelResult,
      sessionStateSummary: orchestration.sessionStateSummary,
      clarificationPayload: orchestration.clarificationPayload ?? null,
    });
  } catch (error) {
    console.error('[TravelChat] Failed to execute travel planning:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to execute travel planning', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
