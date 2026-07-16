import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    { ok: true, service: 'quantpilot-web' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
