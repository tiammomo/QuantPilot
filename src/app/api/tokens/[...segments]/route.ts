import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  deleteServiceToken,
  getPlainServiceToken,
  getServiceToken,
  touchServiceToken,
} from '@/lib/services/tokens';

interface RouteContext {
  params: Promise<{ segments?: string[] }>;
}

function isProvider(value: string): boolean {
  return value === 'github' || value === 'supabase' || value === 'vercel';
}

function internalTokenApiEnabled(): boolean {
  return process.env.QUANTPILOT_ENABLE_INTERNAL_TOKEN_API === '1';
}

function internalTokenApiAuthorized(request: NextRequest): boolean {
  const expected = process.env.QUANTPILOT_INTERNAL_API_TOKEN;
  const provided = request.headers.get('x-quantpilot-internal-token');
  if (!expected || !provided) {
    return false;
  }
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { segments = [] } = await params;

  if (segments.length === 1) {
    try {
      await requireAction({
        headers: request.headers,
        action: 'platform.tokens.manage',
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return authErrorResponse(error);
      throw error;
    }
    const provider = segments[0];
    if (!isProvider(provider)) {
      return NextResponse.json(
        { success: false, error: 'Invalid provider' },
        { status: 400 },
      );
    }

    const record = await getServiceToken(provider);
    if (!record) {
      return NextResponse.json({ success: false, error: 'Token not found' }, { status: 404 });
    }

    const response = NextResponse.json(record);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  if (segments.length === 3 && segments[0] === 'internal' && segments[2] === 'token') {
    if (!internalTokenApiEnabled()) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    if (!internalTokenApiAuthorized(request)) {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }

    const provider = segments[1];
    if (!isProvider(provider)) {
      return NextResponse.json(
        { success: false, error: 'Invalid provider' },
        { status: 400 },
      );
    }

    const token = await getPlainServiceToken(provider);
    if (!token) {
      return NextResponse.json({ success: false, error: 'Token not found' }, { status: 404 });
    }

    await touchServiceToken(provider);
    const response = NextResponse.json({ token });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }

  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const { segments = [] } = await params;

  if (segments.length !== 1) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.tokens.manage',
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    throw error;
  }

  const tokenId = segments[0];
  const deleted = await deleteServiceToken(tokenId);
  if (!deleted) {
    return NextResponse.json({ success: false, error: 'Token not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, message: 'Token deleted successfully' });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
