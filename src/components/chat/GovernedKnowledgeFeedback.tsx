'use client';

import { BookOpenCheck, CheckCircle2, CircleMinus, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { KnowledgeFeedbackOutcome } from '@/lib/platform/knowledge/types';

import {
  GovernedKnowledgeFeedbackClientError,
  loadGovernedKnowledgeAttribution,
  submitGovernedKnowledgeFeedback,
  type GovernedKnowledgeAttributionView,
} from './knowledge-feedback-client';

interface GovernedKnowledgeFeedbackProps {
  projectId: string;
  requestId: string;
}

const LABELS: Record<KnowledgeFeedbackOutcome, string> = {
  helped: '有帮助',
  neutral: '一般',
  harmed: '有伤害',
};

export default function GovernedKnowledgeFeedback({
  projectId,
  requestId,
}: GovernedKnowledgeFeedbackProps) {
  const [use, setUse] = useState<GovernedKnowledgeAttributionView | null>(null);
  const [hidden, setHidden] = useState(false);
  const [submitting, setSubmitting] = useState<KnowledgeFeedbackOutcome | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setUse(null);
    setHidden(false);
    setError('');
    void loadGovernedKnowledgeAttribution({ projectId, requestId, signal: controller.signal })
      .then(setUse)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof GovernedKnowledgeFeedbackClientError && cause.code === 'KNOWLEDGE_USE_NOT_FOUND') {
          setHidden(true);
          return;
        }
        setHidden(true);
      });
    return () => controller.abort();
  }, [projectId, requestId]);

  if (hidden || !use || (!use.feedbackAvailable && use.feedbackStatus !== 'completed')) return null;

  async function submit(outcome: KnowledgeFeedbackOutcome) {
    setSubmitting(outcome);
    setError('');
    try {
      setUse(await submitGovernedKnowledgeFeedback({ projectId, requestId, outcome }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '知识效果反馈提交失败，请重试。');
    } finally {
      setSubmitting(null);
    }
  }

  const retryOutcome = use.feedbackStatus === 'failed' ? use.feedbackOutcome : null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-indigo-500/15 bg-indigo-500/[0.03] px-3 py-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-foreground/80">
        <BookOpenCheck className="h-3.5 w-3.5 text-indigo-600" />
        本轮使用了 {use.citationCount} 条受治理知识引用
      </span>
      {use.feedbackStatus === 'completed' && use.feedbackOutcome ? (
        <span role="status" className="flex items-center gap-1 text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          已形成效果证据：{LABELS[use.feedbackOutcome]}
        </span>
      ) : retryOutcome ? (
        <button
          type="button"
          disabled={submitting !== null}
          onClick={() => void submit(retryOutcome)}
          className="rounded-full border border-amber-500/30 bg-background px-2 py-1 text-amber-700 disabled:opacity-50"
        >
          {submitting ? '重试中…' : `重试提交“${LABELS[retryOutcome]}”`}
        </button>
      ) : (
        <>
          <button type="button" disabled={submitting !== null} onClick={() => void submit('helped')} className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-foreground/70 hover:border-emerald-500/40 hover:text-emerald-700 disabled:opacity-50">
            <ThumbsUp className="h-3 w-3" />{submitting === 'helped' ? '提交中…' : '有帮助'}
          </button>
          <button type="button" disabled={submitting !== null} onClick={() => void submit('neutral')} className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-foreground/70 hover:border-slate-500/40 disabled:opacity-50">
            <CircleMinus className="h-3 w-3" />{submitting === 'neutral' ? '提交中…' : '一般'}
          </button>
          <button type="button" disabled={submitting !== null} onClick={() => void submit('harmed')} className="flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-foreground/70 hover:border-red-500/40 hover:text-red-700 disabled:opacity-50">
            <ThumbsDown className="h-3 w-3" />{submitting === 'harmed' ? '提交中…' : '有伤害'}
          </button>
        </>
      )}
      {error ? <span role="alert" className="basis-full text-red-600">{error}</span> : null}
    </div>
  );
}
