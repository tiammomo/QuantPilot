import { NextRequest, NextResponse } from 'next/server';

import { requireAdminSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { prisma } from '@/lib/db/client';

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession(request.headers);
    const eventType = request.nextUrl.searchParams.get('eventType')?.trim() || '';
    const limit = Math.min(100, Math.max(1, Number.parseInt(request.nextUrl.searchParams.get('limit') || '50', 10)));
    const events = await prisma.authAuditEvent.findMany({
      where: eventType ? { eventType: { startsWith: eventType } } : undefined,
      select: {
        id: true,
        eventType: true,
        targetType: true,
        targetId: true,
        outcome: true,
        ipAddress: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const response = NextResponse.json({ success: true, data: events });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
