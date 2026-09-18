import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAction } from "@/lib/auth/action";
import { AuthorizationError } from "@/lib/auth/authorization";
import { authErrorResponse } from "@/lib/auth/http";
import {
  assertManagedProjectId,
  assertManagedWorkspaceExists,
} from "@/lib/data-agent/workspace-path";
import { getProjectById } from "@/lib/services/project";
import {
  assertAuthorizedSkillMutation,
  PrivilegedRequestError,
} from "@/lib/server/privileged-request";
import { SkillConflictError } from "@/lib/agent/skills/catalog-store";
import { deployProjectSkills } from "@/lib/quant/skills-deployment";

const schema = z
  .object({
    projectId: z.string().min(1).max(128),
    target: z.enum(["pi-agent", "claude-code", "codex"]),
    action: z.enum(["install", "uninstall", "rollback"]),
    skillId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .optional(),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(32)
      .optional(),
    expectedRevision: z.string().uuid().nullable(),
    overwriteModified: z.boolean().optional(),
  })
  .strict();
export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success)
      return NextResponse.json(
        { success: false, error: "安装请求无效。" },
        { status: 400 },
      );
    const input = parsed.data;
    if (assertManagedProjectId(input.projectId) !== input.projectId)
      throw new Error("项目 ID 无效。");
    const context = await requireAction({
      headers: request.headers,
      action: "project.update",
      projectId: input.projectId,
    });
    await requireAction({
      headers: request.headers,
      action: "quant.data.read",
    });
    assertAuthorizedSkillMutation(request, context);
    const project = await getProjectById(input.projectId);
    if (!project)
      return NextResponse.json(
        { success: false, error: "项目不存在。" },
        { status: 404 },
      );
    const workspace = await assertManagedWorkspaceExists(
      input.projectId,
      project.repoPath,
    );
    const data = await deployProjectSkills({
      ...input,
      workspace,
      actor: context.actorUserId,
    });
    return NextResponse.json(
      { success: true, data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    const status =
      error instanceof SkillConflictError ||
      error instanceof PrivilegedRequestError
        ? error.status
        : 400;
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "安装失败。",
      },
      { status },
    );
  }
}
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
