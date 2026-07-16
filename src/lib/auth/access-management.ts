import type { PermissionEffect } from '@/lib/auth/permissions';
import {
  ACCESS_CONTROL_CATALOG,
  PERMISSION_ACTIONS,
  isPermissionAction,
} from '@/lib/auth/permissions';
import { isPlatformAdmin } from '@/lib/auth/authorization';
import { prisma } from '@/lib/db/client';
import { calculateQuotaWindow, resolveQuotaPolicy } from '@/lib/quota';
import { DEFAULT_QUOTA_RULES } from '@/lib/quota/defaults';

function decimal(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function activeAt(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > now.getTime();
}

function effectFor(
  records: readonly { permissionKey: string; effect: string; expiresAt?: Date | null }[],
  action: string,
  now: Date,
): PermissionEffect | null {
  const record = records.find((candidate) => (
    candidate.permissionKey === action &&
    activeAt(candidate.expiresAt ?? null, now) &&
    (candidate.effect === 'allow' || candidate.effect === 'deny')
  ));
  return record?.effect === 'allow' || record?.effect === 'deny' ? record.effect : null;
}

export async function loadAccessControlCatalog() {
  const [permissionProfiles, quotaProfiles] = await prisma.$transaction([
    prisma.permissionProfile.findMany({
      include: { grants: { orderBy: { permissionKey: 'asc' } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
    prisma.quotaProfile.findMany({
      include: { rules: { orderBy: { metric: 'asc' } } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }),
  ]);

  return {
    version: ACCESS_CONTROL_CATALOG.version,
    actions: PERMISSION_ACTIONS.map((key) => ({
      key,
      ...ACCESS_CONTROL_CATALOG.actions[key],
    })),
    permissionProfiles: permissionProfiles.map((profile) => ({
      id: profile.id,
      key: profile.key,
      name: profile.name,
      description: profile.description,
      isDefault: profile.isDefault,
      grants: profile.grants.map((grant) => ({
        permissionKey: grant.permissionKey,
        effect: grant.effect,
      })),
    })),
    quotaProfiles: quotaProfiles.map((profile) => ({
      id: profile.id,
      key: profile.key,
      name: profile.name,
      description: profile.description,
      isDefault: profile.isDefault,
      rules: profile.rules.map((rule) => ({
        metric: rule.metric,
        limit: rule.limit.toString(),
        enforcement: rule.enforcement,
        windowType: rule.windowType,
        windowSeconds: rule.windowSeconds,
        reservationTtlSeconds: rule.reservationTtlSeconds,
      })),
    })),
  };
}

export async function loadUserAccessDetails(userId: string) {
  const now = new Date();
  const [user, defaultPermissionProfile, defaultQuotaProfile, observedQuotaMetrics] = await prisma.$transaction([
    prisma.authUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        accessVersion: true,
        permissionProfileId: true,
        quotaProfileId: true,
        permissionProfile: {
          include: { grants: { orderBy: { permissionKey: 'asc' } } },
        },
        permissionOverrides: { orderBy: { permissionKey: 'asc' } },
        quotaProfile: {
          include: { rules: { orderBy: { metric: 'asc' } } },
        },
        quotaOverrides: { orderBy: { metric: 'asc' } },
      },
    }),
    prisma.permissionProfile.findFirst({
      where: { isDefault: true },
      include: { grants: { orderBy: { permissionKey: 'asc' } } },
    }),
    prisma.quotaProfile.findFirst({
      where: { isDefault: true },
      include: { rules: { orderBy: { metric: 'asc' } } },
    }),
    prisma.usageBucket.findMany({
      where: { actorUserId: userId },
      select: { metric: true },
      distinct: ['metric'],
    }),
  ]);
  if (!user) return null;

  const admin = isPlatformAdmin(user);
  const effectivePermissionProfile = user.permissionProfile ?? defaultPermissionProfile;
  const profileGrants = effectivePermissionProfile?.grants ?? [];
  const permissions = PERMISSION_ACTIONS.map((action) => {
    const overrideEffect = effectFor(user.permissionOverrides, action, now);
    const profileEffect = effectFor(profileGrants, action, now);
    const denied = overrideEffect === 'deny' || profileEffect === 'deny';
    const allowed = admin || (!denied && (overrideEffect === 'allow' || profileEffect === 'allow'));
    const source = admin
      ? 'administrator'
      : overrideEffect
        ? `user-override:${overrideEffect}`
        : profileEffect
          ? `profile:${profileEffect}`
          : 'not-granted';
    return {
      action,
      ...ACCESS_CONTROL_CATALOG.actions[action],
      allowed,
      source,
      projectRoleRequired: ACCESS_CONTROL_CATALOG.actions[action].scope === 'project',
    };
  });

  const metrics = [...new Set([
    ...DEFAULT_QUOTA_RULES.map((rule) => rule.metric),
    ...(defaultQuotaProfile?.rules.map((rule) => rule.metric) ?? []),
    ...(user.quotaProfile?.rules.map((rule) => rule.metric) ?? []),
    ...user.quotaOverrides.map((override) => override.metric),
    ...observedQuotaMetrics.map((bucket) => bucket.metric),
  ])].sort();

  const quotas = await Promise.all(metrics.map(async (metric) => {
    const policy = await resolveQuotaPolicy(user.id, metric, now);
    const window = calculateQuotaWindow(policy.windowType, now, policy.windowSeconds);
    const bucket = await prisma.usageBucket.findUnique({
      where: {
        actorUserId_metric_windowStart_windowEnd: {
          actorUserId: user.id,
          metric,
          windowStart: window.start,
          windowEnd: window.end,
        },
      },
      select: { used: true, reserved: true },
    });
    const used = bucket?.used ?? 0n;
    const reserved = bucket?.reserved ?? 0n;
    const remaining = policy.limit === null
      ? null
      : policy.limit > used + reserved
        ? policy.limit - used - reserved
        : 0n;
    return {
      metric,
      source: policy.source,
      unlimited: policy.unlimited,
      enforcement: policy.enforcement,
      limit: decimal(policy.limit),
      used: used.toString(),
      reserved: reserved.toString(),
      remaining: decimal(remaining),
      exceeded: policy.limit !== null && used + reserved > policy.limit,
      windowType: policy.windowType,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    };
  }));

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isAdmin: admin,
      accessVersion: user.accessVersion,
    },
    permissionProfile: effectivePermissionProfile
      ? {
          id: effectivePermissionProfile.id,
          key: effectivePermissionProfile.key,
          name: effectivePermissionProfile.name,
        }
      : null,
    quotaProfile: user.quotaProfile
      ? {
          id: user.quotaProfile.id,
          key: user.quotaProfile.key,
          name: user.quotaProfile.name,
        }
      : null,
    permissions,
    permissionOverrides: user.permissionOverrides
      .filter((override) => isPermissionAction(override.permissionKey))
      .map((override) => ({
        permissionKey: override.permissionKey,
        effect: override.effect,
        reason: override.reason,
        expiresAt: override.expiresAt?.toISOString() ?? null,
      })),
    quotas,
    quotaOverrides: user.quotaOverrides.map((override) => ({
      metric: override.metric,
      isUnlimited: override.isUnlimited,
      limit: decimal(override.limit),
      enforcement: override.enforcement,
      windowType: override.windowType,
      windowSeconds: override.windowSeconds,
      reservationTtlSeconds: override.reservationTtlSeconds,
      reason: override.reason,
      expiresAt: override.expiresAt?.toISOString() ?? null,
    })),
  };
}
