import { getCapabilityCenterData } from '@/lib/quant/capability-center';
import CapabilityCenterClient from './CapabilityCenterClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '数据平台 · QuantPilot',
};

export default async function CapabilitiesPage() {
  const data = await getCapabilityCenterData();
  return <CapabilityCenterClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
