import { getWorkspaceHealthDashboard } from '@/lib/quant/workspace-health';
import { getGenerationObservabilityDashboard } from '@/lib/quant/generation-observability';
import WorkspacesHealthClient from './WorkspacesHealthClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '运维平台 · QuantPilot',
};

type Props = {
  searchParams?: Promise<{ view?: string }>;
};

export default async function WorkspacesPage({ searchParams }: Props) {
  const params = await searchParams;
  const [data, traceData] = await Promise.all([
    getWorkspaceHealthDashboard(),
    getGenerationObservabilityDashboard(),
  ]);
  return (
    <WorkspacesHealthClient
      initialData={data}
      initialTraceData={traceData}
      initialView={params?.view === 'trace' ? 'trace' : 'health'}
    />
  );
}

export const dynamic = 'force-dynamic';
