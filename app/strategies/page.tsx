import type { Metadata } from 'next';
import { getStrategyDashboardData } from '@/lib/quant/strategies';
import StrategyPlatformClient from './StrategyPlatformClient';

export const metadata: Metadata = {
  title: '策略平台 · QuantPilot',
};

export default async function StrategiesPage() {
  const data = await getStrategyDashboardData();
  return <StrategyPlatformClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
