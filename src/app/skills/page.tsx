import { getSkillsDashboardData } from '@/lib/quant/skills-dashboard';
import SkillsManagementClient from './SkillsManagementClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Skills Market · QuantPilot',
  description: '发现、理解并治理 QuantPilot 的研究技能与工作流能力。',
};

export default async function SkillsManagementPage() {
  const data = await getSkillsDashboardData();
  return <SkillsManagementClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
