/** Append-only decisions. Never derive a review time from a row's updatedAt. */
export interface ApprovalLogEntry {
  userId: number;
  at: string;
  stage: string;
  result: string;
  note?: string;
}
export function appendApproval(row: { approvalLog?: ApprovalLogEntry[] }, userId: number, stage: string, result: string, note?: string) {
  row.approvalLog = [...(row.approvalLog || []), { userId, at: new Date().toISOString(), stage, result, ...(note ? { note } : {}) }];
}
