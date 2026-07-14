import { getCapabilityCenterData } from '@/lib/quant/capability-center';
import BusinessKnowledgeClient from './BusinessKnowledgeClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '量化业务知识中心 · QuantPilot',
  description: 'QuantPilot 量化业务能力、典型场景、交付规范与执行依赖。',
};

export default async function BusinessKnowledgePage() {
  const data = await getCapabilityCenterData();
  return <BusinessKnowledgeClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
