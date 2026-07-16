import { randomBytes, randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { requireAdminSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { hashAuthPassword } from '@/lib/auth/password';
import { prisma } from '@/lib/db/client';

const createUserSchema = z.object({
  email: z.string().trim().email().max(320),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['admin', 'member']).default('member'),
  password: z.string().min(12).max(128).optional(),
}).strict();

const updateUserSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set-role'), userId: z.string().min(1), role: z.enum(['admin', 'member']) }),
  z.object({ action: z.literal('set-status'), userId: z.string().min(1), banned: z.boolean(), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal('reset-password'), userId: z.string().min(1) }),
  z.object({ action: z.literal('revoke-sessions'), userId: z.string().min(1) }),
]);

function temporaryPassword(): string {
  return `${randomBytes(12).toString('base64url')}Aa1!`;
}

async function ensureNotLastAdmin(
  transaction: Prisma.TransactionClient,
  userId: string,
) {
  // Serialize every operation that can remove an active administrator. The
  // check and the mutation must share this transaction or two simultaneous
  // demotions could both observe another administrator and leave none.
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended('auth:active-admin-governance', 0))
  `;
  const target = await transaction.authUser.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (target?.role !== 'admin') return;
  const activeAdmins = await transaction.authUser.count({
    where: {
      role: 'admin',
      OR: [{ banned: false }, { banExpires: { lte: new Date() } }],
    },
  });
  if (activeAdmins <= 1) throw new Error('不能停用或降级最后一个可用管理员。');
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession(request.headers);
    const query = request.nextUrl.searchParams.get('q')?.trim() || '';
    const page = Math.max(1, Number.parseInt(request.nextUrl.searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(request.nextUrl.searchParams.get('pageSize') || '25', 10)));
    const where = query
      ? {
          OR: [
            { email: { contains: query, mode: 'insensitive' as const } },
            { name: { contains: query, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const [total, users] = await prisma.$transaction([
      prisma.authUser.count({ where }),
      prisma.authUser.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          banned: true,
          banReason: true,
          mustChangePassword: true,
          lastLoginAt: true,
          passwordChangedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { sessions: true, projectMemberships: true, ownedProjects: true } },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const response = NextResponse.json({ success: true, data: { users, total, page, pageSize } });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireAdminSession(request.headers, { fresh: true });
    const input = createUserSchema.parse(await request.json());
    const email = input.email.toLowerCase();
    const initialPassword = input.password || temporaryPassword();
    const passwordHash = await hashAuthPassword(initialPassword);
    const userId = randomUUID();
    const now = new Date();
    await prisma.$transaction(async (transaction) => {
      await transaction.authUser.create({
        data: {
          id: userId,
          email,
          name: input.name,
          role: input.role,
          emailVerified: true,
          mustChangePassword: true,
          ...(input.role === 'member'
            ? {
                permissionProfile: { connect: { key: 'member-default' } },
                quotaProfile: { connect: { key: 'member-default' } },
              }
            : {}),
          createdAt: now,
          updatedAt: now,
        },
      });
      await transaction.authAccount.create({
        data: {
          id: randomUUID(),
          providerId: 'credential',
          accountId: userId,
          userId,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        },
      });
    });
    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: 'admin.user_created',
      targetType: 'user',
      targetId: userId,
      outcome: 'success',
      headers: request.headers,
      metadata: { role: input.role },
    });
    const response = NextResponse.json({
      success: true,
      data: { userId, email, initialPassword, mustChangePassword: true },
    }, { status: 201 });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireAdminSession(request.headers, { fresh: true });
    const input = updateUserSchema.parse(await request.json());
    const target = await prisma.authUser.findUnique({ where: { id: input.userId } });
    if (!target) return NextResponse.json({ success: false, error: 'USER_NOT_FOUND' }, { status: 404 });

    let responseData: Record<string, unknown> = {};
    if (input.action === 'set-role') {
      if (input.userId === session.user.id) throw new Error('不能修改自己的管理员角色。');
      const defaults = input.role === 'member'
        ? await prisma.$transaction([
            prisma.permissionProfile.findUnique({ where: { key: 'member-default' }, select: { id: true } }),
            prisma.quotaProfile.findUnique({ where: { key: 'member-default' }, select: { id: true } }),
          ])
        : null;
      if (input.role === 'member' && (!defaults?.[0] || !defaults[1])) {
        throw new Error('默认权限或配额模板尚未初始化。');
      }
      await prisma.$transaction(async (transaction) => {
        if (input.role !== 'admin') {
          await ensureNotLastAdmin(transaction, input.userId);
        }
        await transaction.authUser.update({
          where: { id: input.userId },
          data: {
            role: input.role,
            permissionProfileId: input.role === 'member' ? defaults![0]!.id : null,
            quotaProfileId: input.role === 'member' ? defaults![1]!.id : null,
            accessVersion: { increment: 1 },
          },
        });
        await transaction.userPermissionOverride.deleteMany({ where: { userId: input.userId } });
        await transaction.userQuotaOverride.deleteMany({ where: { userId: input.userId } });
        await transaction.authSession.deleteMany({ where: { userId: input.userId } });
      });
      responseData = { role: input.role };
    } else if (input.action === 'set-status') {
      if (input.userId === session.user.id && input.banned) throw new Error('不能停用自己的账号。');
      await prisma.$transaction(async (transaction) => {
        if (input.banned) {
          await ensureNotLastAdmin(transaction, input.userId);
        }
        await transaction.authUser.update({
          where: { id: input.userId },
          data: {
            banned: input.banned,
            banReason: input.banned ? input.reason || '由管理员停用' : null,
            banExpires: null,
          },
        });
        if (input.banned) {
          await transaction.authSession.deleteMany({ where: { userId: input.userId } });
        }
      });
      responseData = { banned: input.banned };
    } else if (input.action === 'reset-password') {
      const initialPassword = temporaryPassword();
      const passwordHash = await hashAuthPassword(initialPassword);
      await prisma.$transaction([
        prisma.authAccount.update({
          where: { providerId_accountId: { providerId: 'credential', accountId: input.userId } },
          data: { password: passwordHash },
        }),
        prisma.authUser.update({
          where: { id: input.userId },
          data: { mustChangePassword: true, passwordChangedAt: null },
        }),
        prisma.authSession.deleteMany({ where: { userId: input.userId } }),
      ]);
      responseData = { initialPassword, mustChangePassword: true };
    } else {
      const result = await prisma.authSession.deleteMany({ where: { userId: input.userId } });
      responseData = { revokedCount: result.count };
    }

    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: `admin.${input.action}`,
      targetType: 'user',
      targetId: input.userId,
      outcome: 'success',
      headers: request.headers,
      metadata: input.action === 'set-role'
        ? { role: input.role }
        : input.action === 'set-status'
          ? { banned: input.banned }
          : {},
    });
    const response = NextResponse.json({ success: true, data: responseData });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
