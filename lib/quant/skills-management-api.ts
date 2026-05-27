import type { SkillDiffData, SkillsPayload, SourceState } from '@/lib/quant/skills-management-types';

async function parseSkillsResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || fallbackMessage);
  }
  return payload.data as T;
}

export async function fetchSkillsDashboard(): Promise<SkillsPayload> {
  const response = await fetch('/api/skills', { cache: 'no-store' });
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
  filePath: string;
  content: string;
}): Promise<SourceState> {
  return postSkillsJson<SourceState>({
    action: 'save-file',
    skillId: params.skillId,
    filePath: params.filePath,
    content: params.content,
  });
}

export function createSkillFolder(params: {
  skillId: string;
  folderPath: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'create-folder',
    skillId: params.skillId,
    folderPath: params.folderPath,
  });
}

export function deleteSkillFile(params: {
  skillId: string;
  filePath: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'delete-file',
    skillId: params.skillId,
    filePath: params.filePath,
  });
}

export function deleteSkillFolder(params: {
  skillId: string;
  folderPath: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'delete-folder',
    skillId: params.skillId,
    folderPath: params.folderPath,
  });
}

export function publishSkillVersion(params: {
  skillId: string;
  version: string;
  summary: string;
  changes: string;
  status: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'publish-version',
    skillId: params.skillId,
    version: params.version,
    summary: params.summary,
    changes: params.changes,
    status: params.status,
  });
}

export function diffSkillVersion(skillId: string): Promise<SkillDiffData> {
  return postSkillsJson<SkillDiffData>({ action: 'diff-version', skillId });
}

export function rollbackSkillVersion(params: {
  skillId: string;
  version: string;
}): Promise<SkillsPayload> {
  return postSkillsJson<SkillsPayload>({
    action: 'rollback-version',
    skillId: params.skillId,
    version: params.version,
  });
}

export function uploadSkillPackage(params: {
  skillId: string;
  version: string;
  summary: string;
  changes: string;
  status: string;
  file: File;
}): Promise<SkillsPayload> {
  const form = new FormData();
  form.set('action', 'upload-package');
  form.set('skillId', params.skillId);
  form.set('version', params.version);
  form.set('summary', params.summary);
  form.set('changes', params.changes);
  form.set('status', params.status);
  form.set('file', params.file);
  return fetch('/api/skills', { method: 'POST', body: form }).then((response) =>
    parseSkillsResponse<SkillsPayload>(response, '上传失败')
  );
}
