export interface AuthContext {
  subject: string;
  roles: string[];
  tenantId: string;
  expiresAt?: number;
}

export function createAuthContext(input: AuthContext): AuthContext {
  return {
    ...input,
    expiresAt: input.expiresAt ?? Date.now() + 1000 * 60 * 60,
  };
}
