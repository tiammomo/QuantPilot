import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACCESS_CONTROL_CATALOG } from '../auth/permissions';
import { DEFAULT_QUOTA_PROFILE, DEFAULT_QUOTA_RULES } from './defaults';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'prisma/migrations/20260716000400_add_permissions_and_usage_quotas/migration.sql',
);
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

function migrationPermissionGrants(profileId: string): string[] {
  const marker = `\n  '${profileId}',\n  permission_key,`;
  const profileOffset = migrationSql.indexOf(marker);
  if (profileOffset < 0) throw new Error(`Migration grant block not found for ${profileId}.`);
  const arrayOffset = migrationSql.indexOf('FROM unnest(ARRAY[', profileOffset);
  const arrayEnd = migrationSql.indexOf(']) AS permission_key;', arrayOffset);
  if (arrayOffset < 0 || arrayEnd < 0) {
    throw new Error(`Migration grant array is malformed for ${profileId}.`);
  }
  return [...migrationSql.slice(arrayOffset, arrayEnd).matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
}

function migrationQuotaRules(): Array<{
  metric: string;
  limit: bigint;
  enforcement: string;
  windowType: string;
  windowSeconds: number | null;
  reservationTtlSeconds: number;
}> {
  const block = migrationSql.match(
    /INSERT INTO "quota_rules"[\s\S]+?\) VALUES([\s\S]+?);\n\nUPDATE "auth_users"/,
  )?.[0];
  if (!block) throw new Error('Migration quota rule seed block was not found.');

  return [...block.matchAll(
    /\('[^']+', 'quota_profile_member_default', '([^']+)', (\d+), '([^']+)', '([^']+)', (NULL|\d+), (\d+),/g,
  )].map((match) => ({
    metric: match[1],
    limit: BigInt(match[2]),
    enforcement: match[3],
    windowType: match[4],
    windowSeconds: match[5] === 'NULL' ? null : Number(match[5]),
    reservationTtlSeconds: Number(match[6]),
  }));
}

describe('built-in access-control defaults', () => {
  it('keeps migration permission grants synchronized with the capability catalog', () => {
    expect(migrationPermissionGrants('permission_profile_member_default'))
      .toEqual([...ACCESS_CONTROL_CATALOG.profiles['member-default'].allow]);
    expect(migrationPermissionGrants('permission_profile_readonly_default'))
      .toEqual([...ACCESS_CONTROL_CATALOG.profiles['readonly-default'].allow]);
    expect(ACCESS_CONTROL_CATALOG.profiles['member-default'].deny).toEqual([]);
    expect(ACCESS_CONTROL_CATALOG.profiles['readonly-default'].deny).toEqual([]);
  });

  it('keeps all eight migration quota rules synchronized with the runtime catalog', () => {
    const expected = DEFAULT_QUOTA_RULES.map((rule) => ({ ...rule }))
      .sort((left, right) => left.metric.localeCompare(right.metric));
    const actual = migrationQuotaRules()
      .sort((left, right) => left.metric.localeCompare(right.metric));

    expect(new Set(DEFAULT_QUOTA_RULES.map((rule) => rule.metric)).size)
      .toBe(DEFAULT_QUOTA_RULES.length);
    expect(actual).toEqual(expected);
    expect(migrationSql).toContain(`'${DEFAULT_QUOTA_PROFILE.key}'`);
    expect(migrationSql).toContain(`'${DEFAULT_QUOTA_PROFILE.name}'`);
    expect(migrationSql).toContain(`'${DEFAULT_QUOTA_PROFILE.description}'`);
  });
});
