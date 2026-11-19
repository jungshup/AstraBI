export interface PolicyRequest {
  action: string;
  user: { id: string; tenantId: string; roles: string[] };
  tenantId: string;
}

export function authorizeAction(request: PolicyRequest): boolean {
  if (request.tenantId !== request.user.tenantId) {
    return false;
  }

  const permissions: Record<string, string[]> = {
    ADMIN: [
      'analytics:query',
      'dashboard:manage',
      'dashboard:view',
      'user:manage',
      'settings:update',
    ],
    MEMBER: ['dashboard:view'],
  };
  return request.user.roles.some((role) => permissions[role]?.includes(request.action) === true);
}
