import { NextResponse } from 'next/server';

import { getWebReadiness } from '@/lib/ops/readiness';

export const dynamic = 'force-dynamic';

export async function GET() {
  const readiness = await getWebReadiness();
  return NextResponse.json(readiness, {
    status: readiness.ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
