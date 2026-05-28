import { redirect } from 'next/navigation';

export default async function LegacyEvalRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  redirect(`/eval-platform/runs/${runId}`);
}
