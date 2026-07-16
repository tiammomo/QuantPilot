import { NextRequest, NextResponse } from 'next/server';

import { loadAccessControlCatalog } from '@/lib/auth/access-management';
import { requireAdminSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession(request.headers);
    const response = NextResponse.json({
      success: true,
      data: await loadAccessControlCatalog(),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
