'use client';

import { BrainCircuit, CheckCircle2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  loadPersonalMemoryAttribution,
  PersonalMemoryClientError,
  type PersonalMemoryFeedbackKind,
  submitPersonalMemoryFeedback,
} from './personal-memory-client';

interface PersonalMemoryFeedbackProps {
  projectId: string;
  requestId: string;
}

export default function PersonalMemoryFeedback({
  projectId,
  requestId,
}: PersonalMemoryFeedbackProps) {
  const [revisionIds, setRevisionIds] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState<PersonalMemoryFeedbackKind | null>(null);
  const [submitted, setSubmitted] = useState<PersonalMemoryFeedbackKind | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setRevisionIds(null);
    setSubmitted(null);
    setError('');
    void loadPersonalMemoryAttribution({
      projectId,
      requestId,
      signal: controller.signal,
    }).then(setRevisionIds).catch((cause) => {
      if (controller.signal.aborted) return;
      if (cause instanceof PersonalMemoryClientError && cause.code === 'MEMORY_USE_NOT_FOUND') {
        setRevisionIds([]);
        return;
      }
      setRevisionIds([]);
    });
    return () => controller.abort();
  }, [projectId, requestId]);

  if (!revisionIds || revisionIds.length === 0) return null;

  async function submit(kind: PersonalMemoryFeedbackKind) {
    setSubmitting(kind);
    setError('');
    try {
      await submitPersonalMemoryFeedback({ projectId, requestId, revisionIds: revisionIds ?? [], kind });
      setSubmitted(kind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '记忆反馈提交失败，请重试。');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/15 bg-primary/[0.03] px-3 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-foreground/80">
        <BrainCircuit className="h-3.5 w-3.5 text-primary" />
        本轮实际使用了 {revisionIds.length} 条个人偏好
      </span>
      {submitted ? (
        <span role="status" className="flex items-center gap-1 text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          已记录：{submitted === 'helpful' ? '有帮助' : '不适合我'}
        </span>
      ) : (
        <>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void submit('helpful')}
            className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-foreground/70 transition-colors hover:border-emerald-500/40 hover:text-emerald-700 disabled:opacity-50"
          >
            <ThumbsUp className="h-3 w-3" />
            {submitting === 'helpful' ? '提交中…' : '有帮助'}
          </button>
          <button
            type="button"
            disabled={submitting !== null}
            onClick={() => void submit('rejected')}
            className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-foreground/70 transition-colors hover:border-amber-500/40 hover:text-amber-700 disabled:opacity-50"
          >
            <ThumbsDown className="h-3 w-3" />
            {submitting === 'rejected' ? '提交中…' : '不适合我'}
          </button>
        </>
      )}
      {error ? <span role="alert" className="basis-full text-red-600">{error}</span> : null}
    </div>
  );
}
