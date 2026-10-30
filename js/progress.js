// A home being complete does not make every draft for that home a completed audit.
// Older backups have completedAt but no completionId; match their exact timestamp.
export function completionMatchesAudit(record, audit, userId) {
  if (!record || record.home_id !== audit.siteId || record.pay_period_start !== audit.payStart) return false;
  if (audit.completionId) return audit.completionId === record.id;
  return Boolean(audit.completedAt && record.completed_by === userId && audit.completedAt === record.completed_at);
}

export const canReopenCompletion = (record, profile) => Boolean(
  record && profile?.is_admin
);
