import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';
import {
  DEFAULT_QUANT_CAPABILITY_ID,
  serializeQuantCapabilities,
} from '@/lib/quant/capabilities';

export async function GET(request: NextRequest) {
  try {
    await requireAction({ headers: request.headers, action: 'quant.data.read' });
  } catch (error) {
    return authErrorResponse(error);
  }
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
