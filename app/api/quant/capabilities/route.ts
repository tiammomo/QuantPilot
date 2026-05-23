import { NextResponse } from 'next/server';
import {
  DEFAULT_QUANT_CAPABILITY_ID,
  serializeQuantCapabilities,
} from '@/lib/quant/capabilities';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      defaultCapabilityId: DEFAULT_QUANT_CAPABILITY_ID,
      capabilities: serializeQuantCapabilities(),
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
