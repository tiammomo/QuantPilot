import { getSkillsDashboardData } from '@/lib/quant/skills-dashboard';
import SkillsManagementClient from './SkillsManagementClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Skills 管理 · QuantPilot',
};

export default async function SkillsManagementPage() {
  const data = await getSkillsDashboardData();
  return <SkillsManagementClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
