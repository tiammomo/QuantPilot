'use client';

import { AlertTriangle, BrainCircuit, CheckCircle2, Pencil, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  PERSONAL_MEMORY_CANDIDATE_CONTRACT,
  type PersonalMemoryCandidate,
} from '@/lib/platform/memory/candidate';
import { PERSONAL_MEMORY_PREFERENCE_KEYS } from '@/lib/platform/memory/candidate-types';

import {
  PERSONAL_MEMORY_PREFERENCE_OPTIONS,
  savePersonalPreference,
  type PersonalMemoryPreferenceKey,
  type PersonalMemoryScope,
} from './personal-memory-client';

interface PersonalMemoryCandidateCardProps {
  projectId: string;
  requestId: string;
  candidate: unknown;
}

const VALID_KEYS = new Set<string>(PERSONAL_MEMORY_PREFERENCE_KEYS);

export function parsePersonalMemoryCandidate(value: unknown): PersonalMemoryCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.contract !== PERSONAL_MEMORY_CANDIDATE_CONTRACT
    || typeof candidate.key !== 'string'
    || !VALID_KEYS.has(candidate.key)
    || typeof candidate.value !== 'string'
    || candidate.value.trim().length === 0
    || candidate.value.length > 1_024
    || (candidate.scope !== 'project' && candidate.scope !== 'global')
    || typeof candidate.reason !== 'string'
  ) {
    return null;
  }
  return candidate as unknown as PersonalMemoryCandidate;
}

function storageKey(projectId: string, requestId: string): string {
  return `quantpilot:memory-candidate:v1:${projectId}:${requestId}`;
}

export function personalMemoryCandidateEventId(requestId: string): string {
  const stableRequestId = requestId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);
  return `memory-candidate:${stableRequestId}`;
}

export default function PersonalMemoryCandidateCard({
  projectId,
  requestId,
  candidate: rawCandidate,
}: PersonalMemoryCandidateCardProps) {
  const candidate = useMemo(() => parsePersonalMemoryCandidate(rawCandidate), [rawCandidate]);
  const [dismissed, setDismissed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState<PersonalMemoryPreferenceKey>(
    candidate?.key ?? 'output.answer_style',
  );
  const [value, setValue] = useState(candidate?.value ?? '');
  const [scope, setScope] = useState<PersonalMemoryScope>(candidate?.scope ?? 'project');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(storageKey(projectId, requestId)) !== null);
    } catch {
      setDismissed(false);
    }
  }, [projectId, requestId]);

  if (!candidate || dismissed) return null;

  function rememberDecision(decision: 'saved' | 'ignored') {
    try {
      localStorage.setItem(storageKey(projectId, requestId), decision);
    } catch {
      // Local dismissal is a convenience only; privacy does not depend on it.
    }
  }

  async function save() {
    const normalized = value.trim();
    if (!normalized || normalized.length > 4_096) {
      setError('请输入 1–4096 个字符的明确偏好。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await savePersonalPreference({
        projectId,
        eventId: personalMemoryCandidateEventId(requestId),
        key,
        value: normalized,
        scope,
      });
      rememberDecision('saved');
      setSaved(true);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '偏好保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div role="status" className="mt-2 flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        已由你确认保存；后续匹配任务才会召回。
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-primary/20 bg-background p-3 text-left shadow-sm">
      <div className="flex items-start gap-2">
        <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">要把它记作长期偏好吗？</p>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            {candidate.reason}。当前只是本地候选，不会自动写入。
          </p>
        </div>
        <button
          type="button"
          aria-label="忽略这条记忆候选"
          title="忽略"
          disabled={saving}
          onClick={() => {
            rememberDecision('ignored');
            setDismissed(true);
          }}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          <label className="block space-y-1 text-xs font-medium text-foreground">
            偏好类型
            <select
              value={key}
              onChange={(event) => setKey(event.target.value as PersonalMemoryPreferenceKey)}
              disabled={saving}
              className="h-9 w-full rounded-lg border bg-background px-2 text-xs"
            >
              {PERSONAL_MEMORY_PREFERENCE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs font-medium text-foreground">
            内容
            <textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={saving}
              rows={4}
              maxLength={4_096}
              className="w-full resize-y rounded-lg border bg-background px-2 py-1.5 text-xs leading-5"
            />
          </label>
          <div className="flex gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} />
              当前项目
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} />
              所有项目
            </label>
          </div>
        </div>
      ) : (
        <p className="mt-2 break-words rounded-lg bg-muted/60 px-2.5 py-2 text-xs leading-5 text-foreground/85">
          {value}
        </p>
      )}

      {error ? (
        <div role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] leading-5 text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error} <Link href="/account/memory" className="underline underline-offset-2">检查记忆设置</Link></span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setEditing(!editing)}>
          <Pencil className="h-3.5 w-3.5" />
          {editing ? '收起编辑' : '先编辑'}
        </Button>
        <Button type="button" size="sm" disabled={saving || !value.trim()} onClick={() => void save()}>
          {saving ? '保存中…' : '确认并保存'}
        </Button>
      </div>
    </div>
  );
}
