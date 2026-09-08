// Display hints only. The database independently checks eligibility under lock.
export interface PendingInvitationState { status: string; expires_at: string; sent_at: string | null }
export function invitationStatusLabel(inv: PendingInvitationState, now: number): string {
  if (inv.status === "sent") return Date.parse(inv.expires_at) <= now ? "Expired invitation" : "Pending invitation — link usable";
  if (inv.status === "prepared") return "Awaiting delivery";
  return ({ accepted: "Accepted", revoked: "Revoked", failed: "Delivery failed" } as Record<string, string>)[inv.status] ?? "Unavailable";
}
export function canReissueInvitation(inv: PendingInvitationState, now: number): boolean {
  return inv.status === "sent" && inv.sent_at !== null && Date.parse(inv.sent_at) <= now - 5 * 60_000;
}
