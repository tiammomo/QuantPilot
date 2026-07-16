import { NextRequest, NextResponse } from 'next/server';

import { loadUserAccessDetails } from '@/lib/auth/access-management';
import { requireAuthSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';

export async function GET(request: NextRequest) {
  try {
    const session = await requireAuthSession(request.headers);
    const details = await loadUserAccessDetails(session.user.id);
    if (!details) {
      return NextResponse.json(
        { success: false, error: 'USER_NOT_FOUND', message: '用户不存在。' },
        { status: 404 },
      );
    }
    const response = NextResponse.json({ success: true, data: details });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
