import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { requireAuthSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { prisma } from '@/lib/db/client';

const revokeSchema = z.object({
  sessionId: z.string().min(1).optional(),
  allOthers: z.boolean().optional(),
}).strict().refine((value) => Boolean(value.sessionId) !== Boolean(value.allOthers), {
  message: 'sessionId 或 allOthers 必须且只能提供一个。',
});

export async function GET(request: NextRequest) {
  try {
    const session = await requireAuthSession(request.headers);
    const sessions = await prisma.authSession.findMany({
      where: { userId: session.user.id, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const response = NextResponse.json({
      success: true,
      data: sessions.map((item) => ({
        ...item,
        isCurrent: item.id === session.session.id,
      })),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await requireAuthSession(request.headers);
    const body = revokeSchema.parse(await request.json());
    const result = await prisma.authSession.deleteMany({
      where: {
        userId: session.user.id,
        ...(body.allOthers
          ? { id: { not: session.session.id } }
          : { id: body.sessionId }),
      },
    });
    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: 'session.revoked',
      targetType: 'session',
      targetId: body.allOthers ? 'all-others' : body.sessionId,
      outcome: 'success',
      headers: request.headers,
      metadata: { revokedCount: result.count },
    });
    return NextResponse.json({ success: true, data: { revokedCount: result.count } });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
