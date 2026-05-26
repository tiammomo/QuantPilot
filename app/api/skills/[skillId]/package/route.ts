import fs from 'fs/promises';
import path from 'path';
import { NextResponse } from 'next/server';

type JsonRecord = Record<string, unknown>;

const ROOT = process.cwd();
const REGISTRY_PATH = path.join(ROOT, '.claude', 'skills.registry.json');
const LOCK_PATH = path.join(ROOT, '.claude', 'skills.lock.json');

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertSafeSkillId(skillId: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(skillId)) {
    throw new Error('skillId 不合法。');
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const content = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(content);
  return isRecord(parsed) ? parsed : {};
}

async function resolvePackagePath(skillId: string) {
  assertSafeSkillId(skillId);
  const [registry, lockRaw] = await Promise.all([
    readJson(REGISTRY_PATH),
    readJson(LOCK_PATH).catch(() => ({})),
  ]);
  const lock = isRecord(lockRaw) ? lockRaw : {};
  const coreSkills = Array.isArray(registry.coreSkills) ? registry.coreSkills : [];
  const exists = coreSkills.some((skill) => isRecord(skill) && skill.id === skillId);
  if (!exists) {
    throw new Error(`未找到核心 skill：${skillId}`);
  }

  const lockSkills = isRecord(lock.skills) ? lock.skills : {};
  const lockEntry = isRecord(lockSkills[skillId]) ? lockSkills[skillId] : {};
  const packagePath = path.resolve(
    ROOT,
    String(lockEntry.packagePath ?? `.claude/skill-packages/${skillId}.tgz`)
  );
  if (!isInside(ROOT, packagePath)) {
    throw new Error('压缩包路径不安全。');
  }
  return packagePath;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ skillId: string }> }
) {
  try {
    const { skillId } = await context.params;
    const packagePath = await resolvePackagePath(skillId);
    const buffer = await fs.readFile(packagePath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${skillId}.tgz"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 404 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
