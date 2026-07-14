import { getWorkspaceHealthDashboard } from '@/lib/quant/workspace-health';
import { getGenerationObservabilityDashboard } from '@/lib/quant/generation-observability';
import { getOpsPlatformDashboard } from '@/lib/ops/ops-platform';
import OpsPlatformClient, { type OpsView } from './OpsPlatformClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '运行治理中心 · QuantPilot',
  description: '统一治理 QuantPilot 服务运行、工作空间交付、生成链路与运行日志。',
};

type Props = {
  searchParams?: Promise<{ view?: string }>;
};

export default async function OpsPlatformPage({ searchParams }: Props) {
  const params = await searchParams;
  const workspaceHealthPromise = getWorkspaceHealthDashboard();
  const [data, traceData, opsData] = await Promise.all([
    workspaceHealthPromise,
    getGenerationObservabilityDashboard(),
    getOpsPlatformDashboard({ workspaceHealth: workspaceHealthPromise }),
  ]);
  const requestedView = params?.view;
  const view: OpsView = requestedView === 'services'
    || requestedView === 'workspaces'
    || requestedView === 'trace'
    || requestedView === 'logs'
    || requestedView === 'overview'
    ? requestedView
    : requestedView === 'health'
      ? 'workspaces'
      : requestedView === 'system' || requestedView === 'docker'
        ? 'services'
        : 'overview';
  return (
    <OpsPlatformClient
      initialData={data}
      initialTraceData={traceData}
      initialOpsData={opsData}
      initialView={view}
    />
  );
}

export const dynamic = 'force-dynamic';
