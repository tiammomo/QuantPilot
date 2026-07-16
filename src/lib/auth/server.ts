import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins/admin';

import { authAdminAccess, authAdminRoles } from '@/lib/auth/admin-access';
import { hashAuthPassword, verifyAuthPassword } from '@/lib/auth/password';
import { getProjectAuthConfig, getProjectAuthSecret } from '@/lib/config/auth';
import { prisma } from '@/lib/db/client';

const config = getProjectAuthConfig();
const baseURL = process.env.BETTER_AUTH_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();

export const auth = betterAuth({
  appName: 'QuantPilot',
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
    transaction: true,
  }),
  ...(baseURL ? { baseURL } : {}),
  basePath: config.basePath,
  secret: getProjectAuthSecret(config),
  ...(config.trustedOrigins.length > 0 ? { trustedOrigins: config.trustedOrigins } : {}),
  emailAndPassword: {
    enabled: true,
    disableSignUp: !config.allowSignUp,
    requireEmailVerification: false,
    minPasswordLength: config.password.minLength,
    maxPasswordLength: config.password.maxLength,
    autoSignIn: false,
    password: {
      hash: hashAuthPassword,
      verify: ({ hash, password }) => verifyAuthPassword(hash, password),
    },
  },
  user: {
    modelName: 'authUser',
    additionalFields: {
      mustChangePassword: {
        type: 'boolean',
        required: true,
        defaultValue: false,
        input: false,
      },
      lastLoginAt: {
        type: 'date',
        required: false,
        input: false,
      },
      passwordChangedAt: {
        type: 'date',
        required: false,
        input: false,
      },
    },
  },
  session: {
    modelName: 'authSession',
    expiresIn: config.session.expiresInSeconds,
    updateAge: config.session.updateAgeSeconds,
    freshAge: config.session.freshAgeSeconds,
    cookieCache: { enabled: false },
  },
  account: {
    modelName: 'authAccount',
  },
  verification: {
    modelName: 'authVerification',
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'authRateLimit',
    window: config.rateLimit.windowSeconds,
    max: config.rateLimit.maxRequests,
    customRules: {
      '/sign-in/email': {
        window: config.rateLimit.signInWindowSeconds,
        max: config.rateLimit.signInMaxRequests,
      },
    },
  },
  advanced: {
    useSecureCookies: config.secureCookies,
    cookiePrefix: 'quantpilot',
    defaultCookieAttributes: {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      path: '/',
    },
  },
  plugins: [
    admin({
      defaultRole: 'member',
      adminRoles: ['admin'],
      ac: authAdminAccess,
      roles: authAdminRoles,
      bannedUserMessage: '账号已被停用，请联系 QuantPilot 管理员。',
    }),
  ],
});

export type ProjectAuthSession = typeof auth.$Infer.Session;
