import { NextResponse } from 'next/server';
import { getSkillsDashboardData } from '@/lib/quant/skills-dashboard';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: await getSkillsDashboardData(),
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
