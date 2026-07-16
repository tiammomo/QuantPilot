import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { loadUserAccessDetails } from '@/lib/auth/access-management';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import {
  AuthorizationError,
  isPlatformAdmin,
  requireAdminSession,
} from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { isPermissionAction } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db/client';
import { getBuiltinQuotaRule } from '@/lib/quota/defaults';
import { ApiError, handleApiError } from '@/lib/utils/api-response';

interface RouteContext {
  params: Promise<{ user_id: string }>;
}

const expiresAtSchema = z.string().trim().refine(
  (value) => Number.isFinite(new Date(value).valueOf()),
  'expiresAt must be an ISO date-time.',
);

const permissionOverrideSchema = z.object({
  permissionKey: z.string().trim().refine(isPermissionAction, 'Unknown permission key.'),
  effect: z.enum(['allow', 'deny']),
  expiresAt: expiresAtSchema.nullable().optional(),
}).strict();

const quotaOverrideSchema = z.object({
  metric: z.string().trim().regex(/^[a-z][a-z0-9_.:-]{0,159}$/),
  isUnlimited: z.boolean().default(false),
  limit: z.string().regex(/^\d+$/).nullable().optional(),
  enforcement: z.enum(['observe', 'warn', 'hard']).default('observe'),
  windowType: z.enum(['minute', 'hour', 'day', 'month', 'fixed', 'lifetime']).default('month'),
  windowSeconds: z.number().int().min(1).max(31_536_000).nullable().optional(),
  reservationTtlSeconds: z.number().int().min(1).max(86_400).default(900),
  expiresAt: expiresAtSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.isUnlimited && value.limit !== null && value.limit !== undefined) {
    context.addIssue({ code: 'custom', path: ['limit'], message: 'Unlimited quota cannot have a limit.' });
  }
  if (!value.isUnlimited && (!value.limit || BigInt(value.limit) <= 0n)) {
    context.addIssue({ code: 'custom', path: ['limit'], message: 'Metered quota requires a positive limit.' });
  }
  if (value.windowType === 'fixed' && !value.windowSeconds) {
    context.addIssue({ code: 'custom', path: ['windowSeconds'], message: 'Fixed window requires windowSeconds.' });
  }
  if (value.windowType !== 'fixed' && value.windowSeconds != null) {
    context.addIssue({ code: 'custom', path: ['windowSeconds'], message: 'Only fixed windows accept windowSeconds.' });
  }
});

const updateAccessSchema = z.object({
  expectedAccessVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500),
  permissionProfileId: z.string().min(1).nullable().optional(),
  quotaProfileId: z.string().min(1).nullable().optional(),
  permissionOverrides: z.array(permissionOverrideSchema).max(100).optional(),
  quotaOverrides: z.array(quotaOverrideSchema).max(100).optional(),
}).strict().superRefine((value, context) => {
  const permissionKeys = value.permissionOverrides?.map((record) => record.permissionKey) ?? [];
  if (new Set(permissionKeys).size !== permissionKeys.length) {
    context.addIssue({
      code: 'custom',
      path: ['permissionOverrides'],
      message: 'permissionOverrides contains duplicates.',
    });
  }
  const quotaMetrics = value.quotaOverrides?.map((record) => record.metric) ?? [];
  if (new Set(quotaMetrics).size !== quotaMetrics.length) {
    context.addIssue({
      code: 'custom',
      path: ['quotaOverrides'],
      message: 'quotaOverrides contains duplicates.',
    });
  }
});

function routeError(error: unknown) {
  if (error instanceof AuthorizationError) return authErrorResponse(error);
  if (error instanceof ApiError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return handleApiError(error, 'AccessControl', '权限与配额操作失败');
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    await requireAdminSession(request.headers);
    const { user_id: userId } = await params;
    const details = await loadUserAccessDetails(userId);
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
    return routeError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const session = await requireAdminSession(request.headers, { fresh: true });
    const { user_id: userId } = await params;
    const input = updateAccessSchema.parse(await request.json());
    const target = await prisma.authUser.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!target) throw new ApiError(404, 'USER_NOT_FOUND', '用户不存在。');

    if (isPlatformAdmin(target)) {
      const attemptsRestriction =
        (input.permissionProfileId !== undefined && input.permissionProfileId !== null) ||
        (input.quotaProfileId !== undefined && input.quotaProfileId !== null) ||
        (input.permissionOverrides?.length ?? 0) > 0 ||
        (input.quotaOverrides?.length ?? 0) > 0;
      if (attemptsRestriction) {
        throw new ApiError(
          409,
          'ADMIN_POLICY_IS_UNLIMITED',
          '管理员固定为全部权限和无限配额；可以查看实际用量，但不能设置限制。',
        );
      }
    }

    const [permissionProfile, quotaProfile, knownMetrics] = await Promise.all([
      input.permissionProfileId
        ? prisma.permissionProfile.findUnique({ where: { id: input.permissionProfileId }, select: { id: true } })
        : Promise.resolve(null),
      input.quotaProfileId
        ? prisma.quotaProfile.findUnique({ where: { id: input.quotaProfileId }, select: { id: true } })
        : Promise.resolve(null),
      input.quotaOverrides?.length
        ? prisma.quotaRule.findMany({
            where: { metric: { in: input.quotaOverrides.map((override) => override.metric) } },
            distinct: ['metric'],
            select: { metric: true },
          })
        : Promise.resolve([]),
    ]);
    if (input.permissionProfileId && !permissionProfile) {
      throw new ApiError(400, 'PERMISSION_PROFILE_NOT_FOUND', '权限模板不存在。');
    }
    if (input.quotaProfileId && !quotaProfile) {
      throw new ApiError(400, 'QUOTA_PROFILE_NOT_FOUND', '配额模板不存在。');
    }
    const knownMetricSet = new Set(knownMetrics.map((record) => record.metric));
    const unknownMetric = input.quotaOverrides?.find((override) => !knownMetricSet.has(override.metric));
    if (unknownMetric) {
      throw new ApiError(400, 'UNKNOWN_QUOTA_METRIC', `未知配额指标：${unknownMetric.metric}`);
    }
    for (const override of input.quotaOverrides ?? []) {
      const rule = getBuiltinQuotaRule(override.metric);
      if (!rule) continue;
      if (override.windowType !== rule.windowType || override.windowSeconds != null) {
        throw new ApiError(
          400,
          'QUOTA_METRIC_WINDOW_FIXED',
          `${override.metric} 的统计窗口固定为 ${rule.windowType}，不能通过用户覆盖改变指标语义。`,
        );
      }
      if (override.reservationTtlSeconds !== rule.reservationTtlSeconds) {
        throw new ApiError(
          400,
          'QUOTA_RESERVATION_TTL_FIXED',
          `${override.metric} 的预留租期由平台固定管理，不能通过用户覆盖改变。`,
        );
      }
      if (
        (override.metric === 'projects.owned' || override.metric === 'agent.concurrent') &&
        override.enforcement !== 'hard'
      ) {
        throw new ApiError(
          400,
          'STRUCTURAL_QUOTA_MUST_BE_HARD',
          `${override.metric} 是结构性配额，必须保持 hard enforcement。`,
        );
      }
      if (
        ['llm.total_tokens.monthly', 'quant.data_units.daily']
          .includes(override.metric) &&
        override.enforcement === 'hard'
      ) {
        throw new ApiError(
          400,
          'POSTPAID_QUOTA_CANNOT_BE_HARD',
          `${override.metric} 当前按实际结果结算，只支持 observe 或 warn。`,
        );
      }
    }

    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.authUser.updateMany({
        where: { id: userId, accessVersion: input.expectedAccessVersion },
        data: {
          ...('permissionProfileId' in input ? { permissionProfileId: input.permissionProfileId } : {}),
          ...('quotaProfileId' in input ? { quotaProfileId: input.quotaProfileId } : {}),
          accessVersion: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ApiError(
          409,
          'ACCESS_POLICY_VERSION_CONFLICT',
          '权限配置已被其他管理员更新，请刷新后重试。',
        );
      }

      if (input.permissionOverrides) {
        await transaction.userPermissionOverride.deleteMany({ where: { userId } });
        if (input.permissionOverrides.length > 0) {
          await transaction.userPermissionOverride.createMany({
            data: input.permissionOverrides.map((override) => ({
              userId,
              permissionKey: override.permissionKey,
              effect: override.effect,
              reason: input.reason,
              expiresAt: override.expiresAt ? new Date(override.expiresAt) : null,
            })),
          });
        }
      }

      if (input.quotaOverrides) {
        await transaction.userQuotaOverride.deleteMany({ where: { userId } });
        if (input.quotaOverrides.length > 0) {
          await transaction.userQuotaOverride.createMany({
            data: input.quotaOverrides.map((override) => ({
              userId,
              metric: override.metric,
              isUnlimited: override.isUnlimited,
              limit: override.isUnlimited ? null : BigInt(override.limit!),
              enforcement: override.enforcement,
              windowType: override.windowType,
              windowSeconds: override.windowType === 'fixed' ? override.windowSeconds : null,
              reservationTtlSeconds: override.reservationTtlSeconds,
              reason: input.reason,
              expiresAt: override.expiresAt ? new Date(override.expiresAt) : null,
            })),
          });
        }
      }
    });

    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: 'admin.access_policy_updated',
      targetType: 'user',
      targetId: userId,
      outcome: 'success',
      headers: request.headers,
      metadata: {
        reason: input.reason,
        permissionOverrideCount: input.permissionOverrides?.length ?? 0,
        quotaOverrideCount: input.quotaOverrides?.length ?? 0,
        expectedAccessVersion: input.expectedAccessVersion,
      },
    });

    const response = NextResponse.json({
      success: true,
      data: await loadUserAccessDetails(userId),
    });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return routeError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
