'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

import { authAdminAccess, authAdminRoles } from '@/lib/auth/admin-access';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [
    adminClient({
      ac: authAdminAccess,
      roles: authAdminRoles,
    }),
  ],
});
