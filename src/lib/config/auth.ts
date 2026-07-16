import authConfigFile from '../../../config/auth.json';

export type QuantPilotAuthMode = 'disabled' | 'local';
export type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProjectAuthConfig {
  schemaVersion: 1;
  mode: QuantPilotAuthMode;
  enabled: boolean;
  basePath: '/api/auth';
  secretEnvs: readonly ['QUANTPILOT_AUTH_SECRET', 'BETTER_AUTH_SECRET'];
  baseUrlEnv: 'BETTER_AUTH_URL';
  allowSignUp: boolean;
  secureCookies: boolean;
  trustedOrigins: string[];
  session: {
    expiresInSeconds: number;
    updateAgeSeconds: number;
    freshAgeSeconds: number;
    rememberMe: boolean;
  };
  password: {
    minLength: number;
    maxLength: number;
    argon2id: {
      memoryCostKiB: number;
      timeCost: number;
      parallelism: number;
      outputLength: number;
    };
  };
  rateLimit: {
    windowSeconds: number;
    maxRequests: number;
    signInWindowSeconds: number;
    signInMaxRequests: number;
  };
  retention: {
    auditDays: number;
    expiredRecordGraceSeconds: number;
  };
  bootstrap: {
    emailEnv: 'QUANTPILOT_AUTH_ADMIN_EMAIL';
    passwordEnv: 'QUANTPILOT_AUTH_ADMIN_PASSWORD';
    nameEnv: 'QUANTPILOT_AUTH_ADMIN_NAME';
    developmentDefaults: {
      login: 'admin';
      email: 'admin@quantpilot.local';
      password: 'admin';
      name: 'QuantPilot 管理员';
    };
  };
  publicPaths: string[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function integerEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function configInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`config/auth.json 中的 ${name} 必须是 ${minimum}-${maximum} 的整数。`);
  }
  return parsed;
}

function modeEnv(value: string | undefined, fallback: QuantPilotAuthMode): QuantPilotAuthMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'disabled') return normalized;
  return fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.startsWith('/'))
    : [];
}

function trustedOrigins(value: string | undefined): string[] {
  return Array.from(new Set((value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => {
      try {
        const url = new URL(item);
        return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      } catch {
        return false;
      }
    })));
}

export function getProjectAuthConfig(
  environment: AuthEnvironment = process.env,
): ProjectAuthConfig {
  const root = record(authConfigFile);
  const local = record(root?.local);
  const session = record(local?.session);
  const password = record(local?.password);
  const argon2id = record(password?.argon2id);
  const rateLimit = record(local?.rateLimit);
  const retention = record(local?.retention);
  const bootstrap = record(local?.bootstrap);
  const defaultMode = root?.defaultMode === 'local' ? 'local' : 'disabled';
  const mode = modeEnv(environment.QUANTPILOT_AUTH_MODE, defaultMode);

  if (
    root?.schemaVersion !== 1 ||
    local?.basePath !== '/api/auth' ||
    local?.baseUrlEnv !== 'BETTER_AUTH_URL' ||
    !Array.isArray(local?.secretEnvs) ||
    local.secretEnvs.join(',') !== 'QUANTPILOT_AUTH_SECRET,BETTER_AUTH_SECRET' ||
    bootstrap?.emailEnv !== 'QUANTPILOT_AUTH_ADMIN_EMAIL' ||
    bootstrap?.passwordEnv !== 'QUANTPILOT_AUTH_ADMIN_PASSWORD' ||
    bootstrap?.nameEnv !== 'QUANTPILOT_AUTH_ADMIN_NAME' ||
    record(bootstrap?.developmentDefaults)?.login !== 'admin' ||
    record(bootstrap?.developmentDefaults)?.email !== 'admin@quantpilot.local' ||
    record(bootstrap?.developmentDefaults)?.password !== 'admin' ||
    record(bootstrap?.developmentDefaults)?.name !== 'QuantPilot 管理员'
  ) {
    throw new Error('config/auth.json does not match the locked QuantPilot auth contract.');
  }

  const passwordMinLength = configInteger(password?.minLength, 'password.minLength', 12, 64);
  const passwordMaxLength = configInteger(
    password?.maxLength,
    'password.maxLength',
    passwordMinLength,
    256,
  );
  const defaultSessionExpires = configInteger(
    session?.expiresInSeconds,
    'session.expiresInSeconds',
    900,
    2_592_000,
  );
  const defaultSessionUpdateAge = configInteger(
    session?.updateAgeSeconds,
    'session.updateAgeSeconds',
    60,
    86_400,
  );
  const defaultSessionFreshAge = configInteger(
    session?.freshAgeSeconds,
    'session.freshAgeSeconds',
    60,
    86_400,
  );

  return {
    schemaVersion: 1,
    mode,
    enabled: mode === 'local',
    basePath: '/api/auth',
    secretEnvs: ['QUANTPILOT_AUTH_SECRET', 'BETTER_AUTH_SECRET'],
    baseUrlEnv: 'BETTER_AUTH_URL',
    allowSignUp: booleanEnv(
      environment.QUANTPILOT_AUTH_ALLOW_SIGNUP,
      local.allowSignUp === true,
    ),
    secureCookies: booleanEnv(
      environment.QUANTPILOT_AUTH_SECURE_COOKIES,
      environment.NODE_ENV === 'production',
    ) || environment.NODE_ENV === 'production',
    trustedOrigins: trustedOrigins(environment.QUANTPILOT_AUTH_TRUSTED_ORIGINS),
    session: {
      expiresInSeconds: integerEnv(
        environment.QUANTPILOT_AUTH_SESSION_EXPIRES_SECONDS,
        defaultSessionExpires,
        900,
        2_592_000,
      ),
      updateAgeSeconds: integerEnv(
        environment.QUANTPILOT_AUTH_SESSION_UPDATE_AGE_SECONDS,
        defaultSessionUpdateAge,
        60,
        86_400,
      ),
      freshAgeSeconds: integerEnv(
        environment.QUANTPILOT_AUTH_SESSION_FRESH_AGE_SECONDS,
        defaultSessionFreshAge,
        60,
        86_400,
      ),
      rememberMe: booleanEnv(
        environment.QUANTPILOT_AUTH_REMEMBER_ME,
        session?.rememberMe === true,
      ),
    },
    password: {
      minLength: passwordMinLength,
      maxLength: passwordMaxLength,
      argon2id: {
        memoryCostKiB: configInteger(
          argon2id?.memoryCostKiB,
          'password.argon2id.memoryCostKiB',
          19_456,
          1_048_576,
        ),
        timeCost: configInteger(argon2id?.timeCost, 'password.argon2id.timeCost', 2, 10),
        parallelism: configInteger(
          argon2id?.parallelism,
          'password.argon2id.parallelism',
          1,
          16,
        ),
        outputLength: configInteger(
          argon2id?.outputLength,
          'password.argon2id.outputLength',
          32,
          128,
        ),
      },
    },
    rateLimit: {
      windowSeconds: configInteger(rateLimit?.windowSeconds, 'rateLimit.windowSeconds', 1, 3_600),
      maxRequests: configInteger(rateLimit?.maxRequests, 'rateLimit.maxRequests', 1, 1_000),
      signInWindowSeconds: configInteger(
        rateLimit?.signInWindowSeconds,
        'rateLimit.signInWindowSeconds',
        10,
        3_600,
      ),
      signInMaxRequests: configInteger(
        rateLimit?.signInMaxRequests,
        'rateLimit.signInMaxRequests',
        1,
        20,
      ),
    },
    retention: {
      auditDays: integerEnv(
        environment.QUANTPILOT_AUTH_AUDIT_RETENTION_DAYS,
        configInteger(retention?.auditDays, 'retention.auditDays', 30, 3_650),
        30,
        3_650,
      ),
      expiredRecordGraceSeconds: integerEnv(
        environment.QUANTPILOT_AUTH_EXPIRED_RECORD_GRACE_SECONDS,
        configInteger(
          retention?.expiredRecordGraceSeconds,
          'retention.expiredRecordGraceSeconds',
          0,
          604_800,
        ),
        0,
        604_800,
      ),
    },
    bootstrap: {
      emailEnv: 'QUANTPILOT_AUTH_ADMIN_EMAIL',
      passwordEnv: 'QUANTPILOT_AUTH_ADMIN_PASSWORD',
      nameEnv: 'QUANTPILOT_AUTH_ADMIN_NAME',
      developmentDefaults: {
        login: 'admin',
        email: 'admin@quantpilot.local',
        password: 'admin',
        name: 'QuantPilot 管理员',
      },
    },
    publicPaths: stringArray(local.publicPaths),
  };
}

export function getDevelopmentAdminDefaults(
  config: ProjectAuthConfig = getProjectAuthConfig(),
  environment: AuthEnvironment = process.env,
): ProjectAuthConfig['bootstrap']['developmentDefaults'] | null {
  if (
    environment.NODE_ENV?.trim().toLowerCase() === 'production' ||
    environment.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() === 'strict'
  ) {
    return null;
  }

  const baseUrl = (
    environment.BETTER_AUTH_URL ||
    environment.NEXT_PUBLIC_APP_URL ||
    'http://localhost'
  ).trim();
  try {
    const hostname = new URL(baseUrl).hostname;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      return null;
    }
  } catch {
    return null;
  }
  return config.bootstrap.developmentDefaults;
}

export function getProjectAuthSecret(
  config: ProjectAuthConfig = getProjectAuthConfig(),
  environment: AuthEnvironment = process.env,
): string {
  const secret = config.secretEnvs
    .map((name) => environment[name]?.trim())
    .find(Boolean);
  if (!config.enabled) return 'quantpilot-auth-disabled-placeholder-secret-000000000000';
  if (!secret || secret.length < 32) {
    throw new Error(
      '本地登录已启用，但 QUANTPILOT_AUTH_SECRET/BETTER_AUTH_SECRET 未配置或少于 32 个字符。',
    );
  }
  return secret;
}

export function isPublicAuthPath(pathname: string, config = getProjectAuthConfig()): boolean {
  return config.publicPaths.some((path) =>
    pathname === path || pathname.startsWith(`${path}/`),
  );
}
