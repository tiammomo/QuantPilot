import { createAccessControl } from 'better-auth/plugins/access';

export const authAdminStatements = {
  user: ['create', 'list', 'set-password', 'get', 'update'],
  session: ['list', 'revoke', 'delete'],
} as const;

export const authAdminAccess = createAccessControl(authAdminStatements);

export const authAdminRole = authAdminAccess.newRole({
  user: ['create', 'list', 'set-password', 'get', 'update'],
  session: ['list', 'revoke', 'delete'],
});

export const authMemberRole = authAdminAccess.newRole({
  user: [],
  session: [],
});

export const authAdminRoles = {
  admin: authAdminRole,
  member: authMemberRole,
};
