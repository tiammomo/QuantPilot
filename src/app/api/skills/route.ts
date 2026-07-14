import { NextResponse } from 'next/server';
import { getSkillsDashboardData } from '@/lib/quant/skills-dashboard';
import { assertPrivilegedMutation, PrivilegedRequestError } from '@/lib/server/privileged-request';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: await getSkillsDashboardData(),
  });
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
    assertPrivilegedMutation(request);
    const skillsAdmin = await import('@/lib/quant/skills-admin');
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
        version: String(form.get('version') ?? ''),
        summary: String(form.get('summary') ?? ''),
        changes: parseChanges(form.get('changes')),
        status: String(form.get('status') ?? '') || null,
        file,
      });
      return NextResponse.json({ success: true, data });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? '');
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
        skillId: String(body.skillId ?? ''),
        filePath: 'SKILL.md',
        content: String(body.skillMd ?? body.content ?? ''),
      });
      return NextResponse.json({ success: true, data: source });
    }
    if (action === 'save-file') {
      const source = await skillsAdmin.saveSkillFile({
        skillId: String(body.skillId ?? ''),
        filePath: String(body.filePath ?? 'SKILL.md'),
        content: String(body.content ?? ''),
      });
      return NextResponse.json({ success: true, data: source });
    }
    if (action === 'delete-file') {
      const data = await skillsAdmin.deleteSkillFile({
        skillId: String(body.skillId ?? ''),
        filePath: String(body.filePath ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'create-folder') {
      const data = await skillsAdmin.createSkillFolder({
        skillId: String(body.skillId ?? ''),
        folderPath: String(body.folderPath ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'delete-folder') {
      const data = await skillsAdmin.deleteSkillFolder({
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
        skillId: String(body.skillId ?? ''),
        version: String(body.version ?? ''),
        summary: String(body.summary ?? ''),
        changes: parseChanges(body.changes),
        status: typeof body.status === 'string' ? body.status : null,
      });
      return NextResponse.json({ success: true, data });
    }
    if (action === 'rollback-version') {
      const data = await skillsAdmin.rollbackSkillVersion({
        skillId: String(body.skillId ?? ''),
        version: String(body.version ?? ''),
      });
      return NextResponse.json({ success: true, data });
    }

    return errorResponse('不支持的 action。');
  } catch (error) {
    return errorResponse(error, error instanceof PrivilegedRequestError ? error.status : 400);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
