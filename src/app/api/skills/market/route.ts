import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  assertManagedProjectId,
  assertManagedWorkspaceExists,
} from '@/lib/data-agent/workspace-path';
import { getProjectById } from '@/lib/services/project';
import { getSkillsMarketData } from '@/lib/quant/skills-market';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'quant.data.read',
    });
    const projectId = new URL(request.url).searchParams.get('projectId');
    let project: { id: string; workspace: string } | undefined;
    if (projectId !== null) {
      try {
        if (assertManagedProjectId(projectId) !== projectId) throw new Error();
      } catch {
        return NextResponse.json(
          { success: false, error: '项目 ID 无效。' },
          { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
      await requireAction({
        headers: request.headers,
        action: 'project.read',
        projectId,
      });
      const record = await getProjectById(projectId);
      if (!record)
        return NextResponse.json(
          { success: false, error: '项目不存在。' },
          { status: 404, headers: { 'Cache-Control': 'private, no-store' } },
        );
      project = {
        id: projectId,
        workspace: await assertManagedWorkspaceExists(
          projectId,
          record.repoPath,
        ),
      };
    }
    return NextResponse.json(
      { success: true, data: await getSkillsMarketData(project) },
      {
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[Skills Market] Inspection failed:', error);
    return NextResponse.json(
      { success: false, error: '无法核验技能或项目工作区，请稍后重试。' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
