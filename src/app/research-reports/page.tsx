import type { Metadata } from 'next';
import { getResearchAutomationDashboard } from '@/lib/quant/research-reports';
import ResearchReportsClient from './ResearchReportsClient';

export const metadata: Metadata = {
  title: '投研日报 · QuantPilot',
};

export default async function ResearchReportsPage() {
  const dashboard = await getResearchAutomationDashboard();
  return <ResearchReportsClient initialData={dashboard} />;
}

export const dynamic = 'force-dynamic';
