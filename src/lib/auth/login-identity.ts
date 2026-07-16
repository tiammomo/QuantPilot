export interface DevelopmentAdminIdentity {
  login: string;
  email: string;
}

export function resolveLoginEmail(
  identity: string,
  developmentAdmin: DevelopmentAdminIdentity | null,
): string {
  const normalized = identity.trim().toLowerCase();
  return developmentAdmin && normalized === developmentAdmin.login
    ? developmentAdmin.email
    : normalized;
}
