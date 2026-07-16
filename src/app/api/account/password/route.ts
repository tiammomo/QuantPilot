import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { auth } from '@/lib/auth/server';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { requireAuthSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { prisma } from '@/lib/db/client';

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(128),
  confirmPassword: z.string().min(1).max(128),
}).strict();

export async function POST(request: NextRequest) {
  let actorUserId: string | null = null;
  try {
    const session = await requireAuthSession(request.headers);
    actorUserId = session.user.id;
    const body = passwordSchema.parse(await request.json());
    if (body.newPassword !== body.confirmPassword) {
      return NextResponse.json(
        { success: false, error: 'PASSWORD_CONFIRMATION_MISMATCH', message: '两次输入的新密码不一致。' },
        { status: 400 },
      );
    }
    if (body.currentPassword === body.newPassword) {
      return NextResponse.json(
        { success: false, error: 'PASSWORD_UNCHANGED', message: '新密码不能与当前密码相同。' },
        { status: 400 },
      );
    }

    await auth.api.changePassword({
      body: {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        revokeOtherSessions: false,
      },
      headers: request.headers,
    });
    await prisma.authUser.update({
      where: { id: session.user.id },
      data: {
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });
    const revoked = await prisma.authSession.deleteMany({
      where: { userId: session.user.id, id: { not: session.session.id } },
    });
    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: 'user.password_changed',
      targetType: 'user',
      targetId: session.user.id,
      outcome: 'success',
      headers: request.headers,
      metadata: { revokedOtherSessions: revoked.count },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    await writeAuthAuditEvent({
      actorUserId,
      eventType: 'user.password_change_failed',
      targetType: 'user',
      targetId: actorUserId,
      outcome: 'failure',
      headers: request.headers,
      metadata: { reason: error instanceof Error ? error.name : 'unknown' },
    });
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
