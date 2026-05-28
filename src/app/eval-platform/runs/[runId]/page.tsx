import { notFound } from 'next/navigation';
import { getQuantEvalRun } from '@/lib/quant/evals';
import EvalRunDetailClient from './EvalRunDetailClient';

export default async function EvalRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const run = await getQuantEvalRun(runId);
  if (!run) {
    notFound();
  }
  return <EvalRunDetailClient run={run} />;
}

export const dynamic = 'force-dynamic';
