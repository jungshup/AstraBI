export interface AuditEntry {
  action: string;
  actor: string;
  tenantId: string;
  createdAt: string;
}

export function auditEvent(action: string, actor: string, tenantId: string): AuditEntry {
  return {
    action,
    actor,
    tenantId,
    createdAt: new Date().toISOString(),
  };
}
