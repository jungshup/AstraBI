export interface PolicyRequest {
  action: string;
  user: { id: string; tenantId: string; email?: string };
  tenantId: string;
}

export function authorizeAction(request: PolicyRequest): boolean {
  if (request.tenantId !== request.user.tenantId) {
    return false;
  }

  const adminActions = ['dashboard:view', 'user:manage', 'settings:update'];
  return adminActions.includes(request.action) || request.user.email?.includes('admin') === true;
}
