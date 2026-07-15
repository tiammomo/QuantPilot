import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/services/project";
import {
  readQuantGenerationState,
  updateQuantGenerationStep,
} from "@/lib/quant/generation-state";
import { startPersistentValidatedPreview } from "@/lib/quant/generation-preview";
import { runQuantGenerationStageLocked } from "@/lib/quant/generation-queue";
import { streamManager } from "@/lib/services/stream";
import {
  capturePlatformMissionCandidate,
  claimQuantMoAgentMissionVerification,
  sealQuantMoAgentMissionCandidate,
  verifyAndRecordQuantMoAgentMission,
  type MoAgentMissionContext,
} from "@/lib/services/moagent-mission-control";
import {
  markMoAgentMissionRepairing,
  MoAgentMissionStateError,
  readMoAgentAcceptedMissionSnapshot,
  readMoAgentMission,
} from "@/lib/services/moagent-mission-store";
import {
  assertUserRequestProjectBinding,
  UserRequestProjectMismatchError,
} from "@/lib/services/user-requests";

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || "./data/projects";
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);

function resolveProjectPath(
  projectId: string,
  repoPath?: string | null,
): string {
  if (repoPath) {
    return path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(/*turbopackIgnore: true*/ process.cwd(), repoPath);
  }
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId);
}

async function loadQuantValidation() {
  return import("@/lib/quant/validation");
}

async function stopProvisionalPreview(projectId: string) {
  const { previewManager } = await import("@/lib/services/preview");
  return previewManager.stop(projectId);
}

function missionContext(
  mission: NonNullable<Awaited<ReturnType<typeof readMoAgentMission>>>,
  projectPath: string,
): MoAgentMissionContext {
  return { ...mission, projectPath };
}

async function terminalMissionResponse(mission: MoAgentMissionContext) {
  const completed = mission.status === "completed";
  const acceptance = completed
    ? await readMoAgentAcceptedMissionSnapshot(
        mission.projectId,
        mission.requestId,
      )
    : null;
  return NextResponse.json(
    {
      success: false,
      error: completed
        ? "Completed Mission cannot be manually revalidated"
        : `Mission is ${mission.status}`,
      code: completed
        ? "MISSION_REVALIDATION_REQUIRES_NEW_REQUEST"
        : "MISSION_TERMINAL",
      message: completed
        ? "该请求已经拥有不可变的 accepted receipt；如需重新验证工作区，请创建新的 request。"
        : `该 Mission 已处于 ${mission.status} 终态，不能追加候选或验收证据。请创建新的 request。`,
      mission: {
        missionId: mission.id,
        generationId: mission.generationId,
        requestId: mission.requestId,
        status: mission.status,
        candidateVersion: mission.candidateVersion,
        acceptedReceiptId: mission.acceptedReceiptId,
      },
      ...(completed ? { acceptance } : {}),
    },
    { status: 409 },
  );
}

function busyMissionResponse(mission: MoAgentMissionContext) {
  return NextResponse.json(
    {
      success: false,
      error: `Mission is ${mission.status}`,
      code: "MISSION_BUSY",
      message:
        "该 Mission 仍在执行或验收中，手动验证不能并发读取或封存正在变化的工作区。请等待当前阶段结束后重试。",
      mission: {
        missionId: mission.id,
        generationId: mission.generationId,
        requestId: mission.requestId,
        status: mission.status,
        candidateVersion: mission.candidateVersion,
      },
    },
    { status: 409 },
  );
}

function committedAcceptance(
  evidence: Awaited<ReturnType<typeof verifyAndRecordQuantMoAgentMission>>,
): boolean {
  return (
    evidence.decision.verdict === "accepted" &&
    evidence.mission.status === "completed" &&
    evidence.receipt.receiptType === "acceptance" &&
    evidence.receipt.verdict === "accepted" &&
    evidence.mission.acceptedReceiptId === evidence.receipt.id
  );
}

function acceptanceProjection(
  evidence: Awaited<ReturnType<typeof verifyAndRecordQuantMoAgentMission>>,
  satisfied: boolean,
) {
  return {
    required: true,
    satisfied,
    verdict: evidence.decision.verdict,
    reasonCodes: evidence.decision.reasonCodes,
    failedCheckIds: evidence.decision.failedCheckIds,
    missionId: evidence.mission.id,
    generationId: evidence.mission.generationId,
    missionStatus: evidence.mission.status,
    candidateVersion: evidence.mission.candidateVersion,
    receiptId: evidence.receipt.id,
    receiptSha256: evidence.receipt.receiptHash,
  };
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: "Project not found" },
        { status: 404 },
      );
    }

    const projectPath = resolveProjectPath(project_id, project.repoPath);
    const quantValidation = await loadQuantValidation();
    const [report, repairPlan, generationState] = await Promise.all([
      quantValidation.readQuantValidationReport(projectPath),
      quantValidation.readQuantValidationRepairPlan(projectPath),
      readQuantGenerationState(projectPath),
    ]);
    const acceptance = generationState?.requestId
      ? await readMoAgentAcceptedMissionSnapshot(
          project_id,
          generationState.requestId,
        )
      : null;
    return NextResponse.json({
      success: true,
      data: report,
      repairPlan,
      generationState,
      acceptance,
    });
  } catch (error) {
    console.error("[API] Failed to read quant validation report:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to read quant validation report",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: "Project not found" },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const requestedRequestId =
      typeof body.requestId === "string" && body.requestId.trim()
        ? body.requestId.trim()
        : undefined;
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : undefined;
    const projectPath = resolveProjectPath(project_id, project.repoPath);
    if (requestedRequestId) {
      try {
        const requestExists = await assertUserRequestProjectBinding(
          project_id,
          requestedRequestId,
        );
        if (!requestExists) {
          return NextResponse.json(
            {
              success: false,
              error: "Request does not exist",
              code: "REQUEST_NOT_FOUND",
              message:
                "手动验证不能创建或伪造 generation requestId；请使用当前请求，或省略 requestId 执行历史项目验证。",
            },
            { status: 404 },
          );
        }
      } catch (error) {
        if (error instanceof UserRequestProjectMismatchError) {
          return NextResponse.json(
            {
              success: false,
              error: "Request ID belongs to a different project",
              code: "REQUEST_PROJECT_MISMATCH",
            },
            { status: 409 },
          );
        }
        throw error;
      }
    }
    return await runQuantGenerationStageLocked({
      projectId: project_id,
      task: async () => {
        const generationState = await readQuantGenerationState(projectPath);
        if (
          requestedRequestId &&
          generationState?.requestId &&
          requestedRequestId !== generationState.requestId
        ) {
          return NextResponse.json(
            {
              success: false,
              error: "Request does not match the current generation",
              code: "GENERATION_REQUEST_ID_MISMATCH",
              message:
                "手动验证 requestId 必须与当前 generation requestId 一致；如需新一轮验证，请创建新的完整请求。",
            },
            { status: 409 },
          );
        }
        const missionLookupRequestId =
          requestedRequestId ?? generationState?.requestId;
        const durableMission = missionLookupRequestId
          ? await readMoAgentMission(project_id, missionLookupRequestId)
          : null;

        const requestId = durableMission?.requestId ?? requestedRequestId;
        let activeMission = durableMission
          ? missionContext(durableMission, projectPath)
          : null;
        if (
          activeMission &&
          ["completed", "failed", "cancelled"].includes(activeMission.status)
        ) {
          return await terminalMissionResponse(activeMission);
        }
        if (
          activeMission &&
          ["running", "repairing", "verifying"].includes(activeMission.status)
        ) {
          return busyMissionResponse(activeMission);
        }

        const quantValidation = await loadQuantValidation();
        let candidateReceipt:
          | Awaited<
              ReturnType<typeof sealQuantMoAgentMissionCandidate>
            >["receipt"]
          | null = null;
        if (
          activeMission &&
          ["repair_required", "candidate_complete"].includes(
            activeMission.status,
          )
        ) {
          await quantValidation.prepareQuantProjectForValidation({
            projectId: project_id,
            projectPath,
          });
          if (activeMission.status === "repair_required") {
            activeMission = missionContext(
              await markMoAgentMissionRepairing({
                missionId: activeMission.id,
                projectId: activeMission.projectId,
                requestId: activeMission.requestId,
              }),
              projectPath,
            );
          }
          const candidate = await capturePlatformMissionCandidate({
            mission: activeMission,
            source: "workspace_recovery",
            summary: "手动验证前，平台基于可信准备后的当前工作区封存恢复候选。",
          });
          const sealed = await sealQuantMoAgentMissionCandidate({
            mission: activeMission,
            candidate,
          });
          activeMission = sealed.mission;
          activeMission = await claimQuantMoAgentMissionVerification(
            activeMission,
          );
          candidateReceipt = sealed.receipt;
        }

        if (requestId) {
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "validation",
            status: "running",
            summary: activeMission
              ? "手动触发 Mission 候选自动验证。"
              : "手动触发自动验证。",
            ...(activeMission
              ? {
                  metadata: {
                    missionId: activeMission.id,
                    generationId: activeMission.generationId,
                    candidateVersion: activeMission.candidateVersion,
                    candidateReceiptId: candidateReceipt?.id,
                  },
                }
              : {}),
          });
        }
        const report = await quantValidation.validateQuantProject({
          projectId: project_id,
          projectPath,
          requestId,
          conversationId,
          cliSource: "validator",
        });
        const repairPlan =
          await quantValidation.readQuantValidationRepairPlan(projectPath);
        const failedChecks = report.checks.filter(
          (check) => check.status === "failed",
        );

        if (!activeMission) {
          let preview: Awaited<
            ReturnType<typeof startPersistentValidatedPreview>
          > | null = null;
          if (report.passed) {
            preview = await startPersistentValidatedPreview({
              projectId: project_id,
            });
            streamManager.publish(project_id, {
              type: "status",
              data: {
                status: "preview_ready",
                message: "自动验证通过，看板预览已恢复。",
                requestId,
                metadata: {
                  previewUrl: preview.url,
                  previewPort: preview.port,
                  validationPassed: true,
                },
              },
            });
          }
          if (requestId) {
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId,
              stepId: "validation",
              status: report.passed ? "success" : "failed",
              summary: report.passed
                ? "手动验证通过。"
                : `手动验证未通过：${failedChecks.length} 项失败。`,
              ...(report.passed
                ? {}
                : {
                    errorMessage: "手动验证未通过。",
                    metadata: {
                      failedChecks: failedChecks.map((check) => ({
                        id: check.id,
                        summary: check.summary,
                      })),
                    },
                  }),
            });
          }

          return NextResponse.json({
            success: true,
            data: report,
            repairPlan,
            preview,
          });
        }

        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId: activeMission.requestId,
          stepId: "validation",
          status: report.passed ? "success" : "failed",
          summary: report.passed
            ? "手动验证报告通过，等待持久预览与独立证据验收。"
            : `手动验证未通过：${failedChecks.length} 项失败。`,
          ...(report.passed
            ? {}
            : {
                errorMessage: "手动验证未通过。",
                metadata: {
                  failedChecks: failedChecks.map((check) => ({
                    id: check.id,
                    summary: check.summary,
                  })),
                },
              }),
        });

        let provisionalPreview: Awaited<
          ReturnType<typeof startPersistentValidatedPreview>
        > | null = null;
        let previewStartError: string | null = null;
        if (report.passed) {
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId: activeMission.requestId,
            stepId: "preview",
            status: "running",
            summary: "验证报告通过，正在启动待验收的持久预览。",
          });
          try {
            provisionalPreview = await startPersistentValidatedPreview({
              projectId: project_id,
            });
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId: activeMission.requestId,
              stepId: "preview",
              status: "success",
              summary: "持久预览已就绪，等待 EvidenceVerifier 验收。",
              metadata: {
                previewUrl: provisionalPreview.url,
                previewPort: provisionalPreview.port,
              },
            });
          } catch (error) {
            previewStartError =
              error instanceof Error ? error.message : String(error);
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId: activeMission.requestId,
              stepId: "preview",
              status: "failed",
              summary:
                "持久预览启动失败，交由 EvidenceVerifier 记录基础设施判定。",
              errorMessage: previewStartError,
            });
          }
        }

        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId: activeMission.requestId,
          stepId: "evidence_verification",
          status: "running",
          summary: "正在验证候选、报告、产物哈希和持久预览。",
        });

        let evidence: Awaited<
          ReturnType<typeof verifyAndRecordQuantMoAgentMission>
        >;
        try {
          evidence = await verifyAndRecordQuantMoAgentMission({
            mission: activeMission,
            preview: provisionalPreview
              ? { url: provisionalPreview.url, port: provisionalPreview.port }
              : { url: "http://127.0.0.1:1", port: 1 },
          });
        } catch (error) {
          if (provisionalPreview) {
            await stopProvisionalPreview(project_id).catch((stopError) => {
              console.error(
                "[API] Failed to stop provisional preview after evidence error:",
                stopError,
              );
            });
          }
          throw error;
        }

        const accepted = committedAcceptance(evidence);
        if (evidence.decision.verdict === "accepted" && !accepted) {
          if (provisionalPreview) {
            await stopProvisionalPreview(project_id).catch((stopError) => {
              console.error(
                "[API] Failed to stop inconsistent accepted preview:",
                stopError,
              );
            });
          }
          throw new Error(
            "EvidenceVerifier returned accepted without a committed acceptance receipt.",
          );
        }

        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId: activeMission.requestId,
          stepId: "evidence_verification",
          status: accepted ? "success" : "failed",
          summary: accepted
            ? "当前候选已获得独立 accepted receipt。"
            : `证据验收未通过：${evidence.decision.verdict}。`,
          metadata: {
            missionId: evidence.mission.id,
            generationId: evidence.mission.generationId,
            candidateVersion: evidence.decision.candidateVersion,
            evidenceReceiptId: evidence.receipt.id,
            evidenceReceiptSha256: evidence.receipt.receiptHash,
            verdict: evidence.decision.verdict,
            reasonCodes: evidence.decision.reasonCodes,
            failedCheckIds: evidence.decision.failedCheckIds,
            ...(previewStartError ? { previewStartError } : {}),
          },
          ...(accepted
            ? {}
            : {
                errorMessage: `证据验收未通过：${evidence.decision.verdict}。`,
              }),
        });

        if (!accepted && provisionalPreview) {
          await stopProvisionalPreview(project_id).catch((error) => {
            console.error(
              "[API] Failed to stop unaccepted provisional preview:",
              error,
            );
          });
          provisionalPreview = null;
        }

        if (accepted) {
          if (!report.passed || !provisionalPreview) {
            throw new Error(
              "Mission acceptance requires a passed report and a ready persistent preview.",
            );
          }
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId: activeMission.requestId,
            stepId: "completed",
            status: "success",
            summary: "手动恢复链路已完成独立证据验收。",
            runStatus: "completed",
            metadata: {
              missionId: evidence.mission.id,
              generationId: evidence.mission.generationId,
              candidateVersion: evidence.mission.candidateVersion,
              acceptedReceiptId: evidence.receipt.id,
              acceptedReceiptSha256: evidence.receipt.receiptHash,
              previewUrl: provisionalPreview.url,
              previewPort: provisionalPreview.port,
            },
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "preview_ready",
              message: "自动验证与独立证据验收通过，看板预览已恢复。",
              requestId: activeMission.requestId,
              metadata: {
                previewUrl: provisionalPreview.url,
                previewPort: provisionalPreview.port,
                validationPassed: true,
                missionId: evidence.mission.id,
                generationId: evidence.mission.generationId,
                acceptedReceiptId: evidence.receipt.id,
                acceptedReceiptSha256: evidence.receipt.receiptHash,
              },
            },
          });
        }

        return NextResponse.json({
          success: true,
          data: report,
          repairPlan,
          preview: accepted ? provisionalPreview : null,
          acceptance: acceptanceProjection(evidence, accepted),
        });
      },
    });
  } catch (error) {
    if (error instanceof MoAgentMissionStateError) {
      return NextResponse.json(
        {
          success: false,
          error: "Mission state conflict",
          code: error.code,
          message: error.message,
        },
        { status: 409 },
      );
    }
    console.error("[API] Failed to run quant validation:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to run quant validation",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
