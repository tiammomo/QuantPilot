import { getSkillsDashboardData } from '@/lib/quant/skills-dashboard';
import SkillsManagementClient from './SkillsManagementClient';

export default async function SkillsManagementPage() {
  const data = await getSkillsDashboardData();
  return <SkillsManagementClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
