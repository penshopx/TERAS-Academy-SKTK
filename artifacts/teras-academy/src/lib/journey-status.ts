export type JourneyVisualState = "complete" | "active" | "pending" | "blocked";

const COMPLETE_STATUSES = new Set([
  "complete",
  "completed",
  "passed",
  "ready",
  "ready for official assessment",
  "competent",
  "valid",
]);

const ACTIVE_STATUSES = new Set([
  "active",
  "in progress",
  "recorded",
  "under review",
  "open",
  "submitted",
]);

const BLOCKED_STATUSES = new Set([
  "not ready",
  "blocked",
  "failed",
  "critical failure",
  "not competent",
  "needs revision",
]);

export function journeyVisualState(status: string): JourneyVisualState {
  const normalized = status.trim().toLowerCase();
  if (BLOCKED_STATUSES.has(normalized)) return "blocked";
  if (COMPLETE_STATUSES.has(normalized)) return "complete";
  if (ACTIVE_STATUSES.has(normalized)) return "active";
  return "pending";
}