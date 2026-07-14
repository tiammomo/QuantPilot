import type { Metadata } from 'next';
import { getResearchAutomationDashboard } from '@/lib/quant/research-reports';
import ResearchReportsClient, { type ResearchView } from './ResearchReportsClient';

export const metadata: Metadata = {
  title: '投研情报中心 · QuantPilot',
  description: '统一管理观察池、研究证据、结构化报告、主题洞察与推送回执。',
};

type Props = { searchParams?: Promise<{ view?: string }> };

export default async function ResearchReportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const dashboard = await getResearchAutomationDashboard();
  const requestedView = params?.view;
  const view: ResearchView = requestedView === 'reports' || requestedView === 'insights' || requestedView === 'automation' ? requestedView : 'overview';
  return <ResearchReportsClient initialData={dashboard} initialView={view} />;
}

export const dynamic = 'force-dynamic';
