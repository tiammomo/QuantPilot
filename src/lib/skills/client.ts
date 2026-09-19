import type { SkillDiffData, SkillsPayload, SourceState } from '@/lib/skills/contracts';

async function parseSkillsResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || fallbackMessage);
  }
  return payload.data as T;
}

export async function fetchSkillsDashboard(): Promise<SkillsPayload> {
  const response = await fetch('/api/skills?view=studio', { cache: 'no-store' });
  return parseSkillsResponse<SkillsPayload>(response, '刷新 skills 状态失败');
}

export async function postSkillsJson<T>(body: Record<string, unknown>, fallbackMessage = 'skills 操作失败'): Promise<T> {
  const response = await fetch('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseSkillsResponse<T>(response, fallbackMessage);
}

export function readSkillFile(skillId: string, filePath: string): Promise<SourceState> {
  return postSkillsJson<SourceState>({ action: 'read-file', skillId, filePath });
}

export function saveSkillFile(params: {
  skillId: string;
  expectedRevision: string;
  filePath: string;
  content: string;
}): Promise<SourceState> {
  return postSkillsJson<SourceState>({
    action: 'save-file',
    skillId: params.skillId,
    expectedRevision: params.expectedRevision,
    filePath: params.filePath,
    content: params.content,
  });
}

export function createSkillFolder(params: {
  skillId: string;
  expectedRevision: string;
  folderPath: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'create-folder',
    skillId: params.skillId,
    expectedRevision: params.expectedRevision,
    folderPath: params.folderPath,
  });
}

export function deleteSkillFile(params: {
  skillId: string;
  expectedRevision: string;
  filePath: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'delete-file',
    skillId: params.skillId,
    expectedRevision: params.expectedRevision,
    filePath: params.filePath,
  });
}

export function deleteSkillFolder(params: {
  skillId: string;
  expectedRevision: string;
  folderPath: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'delete-folder',
    skillId: params.skillId,
    expectedRevision: params.expectedRevision,
    folderPath: params.folderPath,
  });
}

export function publishSkillVersion(params: {
  skillId: string;
  expectedRevision: string;
  version: string;
  summary: string;
  changes: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'publish-version',
    skillId: params.skillId,
    expectedRevision: params.expectedRevision,
    version: params.version,
    summary: params.summary,
    changes: params.changes,
  });
}

export function diffSkillVersion(skillId: string): Promise<SkillDiffData> {
  return postSkillsJson<SkillDiffData>({ action: 'diff-version', skillId });
}

export function rollbackSkillVersion(params: {
  skillId: string;
  expectedRevision: string;
  version: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'rollback-version',
    skillId: params.skillId,
    expectedRevision: params.expectedRevision,
    version: params.version,
  });
}

export function uploadSkillPackage(params: {
  skillId: string;
  expectedRevision: string;
  file: File;
}): Promise<SkillsPayload> {
  const form = new FormData();
  form.set('action', 'upload-package');
  form.set('skillId', params.skillId);
  form.set('expectedRevision', params.expectedRevision);
  form.set('file', params.file);
  return fetch('/api/skills', { method: 'POST', body: form }).then((response) =>
    parseSkillsResponse<SkillsPayload>(response, '上传失败')
  );
}

export function discardSkillDraft(params: { skillId: string; expectedRevision: string }): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({ action: 'discard-draft', ...params });
}
