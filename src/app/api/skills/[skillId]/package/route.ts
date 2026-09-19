import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { isCanonicalSkillId } from '@/lib/agent/skills/workspace-integrity';
import { readVerifiedSkillPackage } from '@/lib/skills/market';

export async function GET(
  request: Request,
  context: { params: Promise<{ skillId: string }> },
) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'quant.data.read',
    });
    const { skillId } = await context.params;
    if (!isCanonicalSkillId(skillId))
      return NextResponse.json(
        { success: false, error: '技能 ID 无效。' },
        { status: 400, headers: { 'Cache-Control': 'private, no-store' } },
      );
    const artifact = await readVerifiedSkillPackage(skillId);
    return new NextResponse(new Uint8Array(artifact.content), {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${skillId}-${artifact.version}.tgz"`,
        'Cache-Control': 'private, no-store',
        'X-Skill-Version': artifact.version,
        'X-Content-SHA256': artifact.sha256,
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      { success: false, error: '技能未发布或完整性校验失败，暂不可下载。' },
      { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
