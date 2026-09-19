import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { createSkillsAdministration } from '@/lib/skills/administration';
import { SkillConflictError } from '@/lib/agent/skills/catalog-store';
import { getSkillsDashboardData } from '@/lib/skills/dashboard';
import { assertAuthorizedSkillMutation, PrivilegedRequestError } from '@/lib/server/privileged-request';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'quant.data.read',
    });
    const studio = new URL(request.url).searchParams.get('view') === 'studio';
    if (studio) await requireAction({ headers: request.headers, action: 'platform.settings.manage' });
    const response = NextResponse.json({
      success: true,
      data: studio ? await createSkillsAdministration().getStudioData() : await getSkillsDashboardData(),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return errorResponse(error, 500);
  }
}

function errorResponse(error: unknown, status = 400) {
  return NextResponse.json(
    {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    },
    { status }
  );
}

function parseChanges(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    const context = await requireAction({
      headers: request.headers,
      action: 'platform.settings.manage',
    });
    assertAuthorizedSkillMutation(request, context);
    const skillsAdmin = createSkillsAdministration();
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const action = String(form.get('action') ?? '');
      if (action !== 'upload-package') {
        return errorResponse('不支持的 multipart action。');
      }
      const file = form.get('file');
      if (!(file instanceof File)) {
        return errorResponse('缺少上传文件。');
      }
      const data = await skillsAdmin.uploadSkillPackage({
        skillId: String(form.get('skillId') ?? ''),
        expectedRevision: String(form.get('expectedRevision') ?? ''),
        actor: context.actorUserId,
        file,
      });
      return NextResponse.json({ success: true, data });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? '');
    const mutation = { expectedRevision: String(body.expectedRevision ?? ''), actor: context.actorUserId };
    if (action === 'discard-draft') {
      return NextResponse.json({ success: true, data: await skillsAdmin.discardDraft({ skillId: String(body.skillId ?? ''), ...mutation }) });
    }
    if (action === 'read-source') {
      const source = await skillsAdmin.readSkillSource(String(body.skillId ?? ''));
      return NextResponse.json({ success: true, data: source });
    }
    if (action === 'read-file') {
      const source = await skillsAdmin.readSkillFile(
        String(body.skillId ?? ''),
        String(body.filePath ?? 'SKILL.md')
      );
      return NextResponse.json({ success: true, data: source });
    }
    if (action === 'save-source') {
      const source = await skillsAdmin.saveSkillSource({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        filePath: 'SKILL.md',
        content: String(body.skillMd ?? body.content ?? ''),
      });
      return NextResponse.json({ success: true, data: source });
    }
    if (action === 'save-file') {
      const source = await skillsAdmin.saveSkillFile({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        filePath: String(body.filePath ?? 'SKILL.md'),
        content: String(body.content ?? ''),
      });
      return NextResponse.json({ success: true, data: source });
    }
    if (action === 'delete-file') {
      const data = await skillsAdmin.deleteSkillFile({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        filePath: String(body.filePath ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'create-folder') {
      const data = await skillsAdmin.createSkillFolder({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        folderPath: String(body.folderPath ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'delete-folder') {
      const data = await skillsAdmin.deleteSkillFolder({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        folderPath: String(body.folderPath ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'diff-version') {
      const data = await skillsAdmin.diffSkillVersion(String(body.skillId ?? ''));
      return NextResponse.json({ success: true, data });
    }
    if (action === 'publish-version') {
      const data = await skillsAdmin.publishSkillVersion({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        version: String(body.version ?? ''),
        summary: String(body.summary ?? ''),
        changes: parseChanges(body.changes),
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'rollback-version') {
      const data = await skillsAdmin.rollbackSkillVersion({
        ...mutation,
        skillId: String(body.skillId ?? ''),
        version: String(body.version ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }

    return errorResponse('不支持的 action。');
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return errorResponse(error, error instanceof PrivilegedRequestError || error instanceof SkillConflictError ? error.status : 400);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
