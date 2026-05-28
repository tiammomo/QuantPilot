import { getQuantEvalDashboardData } from '@/lib/quant/evals';
import EvalsDashboardClient from './EvalsDashboardClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '评测平台 · QuantPilot',
};

export default async function EvalPlatformPage() {
  const data = await getQuantEvalDashboardData();
  return <EvalsDashboardClient data={data} />;
}

export const dynamic = 'force-dynamic';
