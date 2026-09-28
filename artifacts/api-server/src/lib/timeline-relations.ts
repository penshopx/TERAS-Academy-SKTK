/** Index records in query order; callers can retain first/last semantics explicitly. */
export function groupTimelineRows<T>(rows: readonly T[], key: (row: T) => string | null | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    if (value == null) continue;
    const group = groups.get(value);
    if (group) group.push(row);
    else groups.set(value, [row]);
  }
  return groups;
}

export function timelineRowsById<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map(row => [key(row), row]));
}

export type OrderedTimelineRow<T> = { position: number; row: T };

export function orderedTimelineGroups<T>(rows: readonly T[], key: (row: T) => string | null | undefined): Map<string, OrderedTimelineRow<T>[]> {
  return groupTimelineRows(rows.map((row, position) => ({ position, row })), item => key(item.row));
}

export function indexTimelineLearningLinks<T extends {
  metadata: { transitionEventId?: unknown };
  practiceAttemptId: string | null;
  evidenceId: string | null;
  evidenceReviewId: string | null;
  remediationPlanId: string | null;
}>(links: readonly T[]) {
  return {
    byTransition: groupTimelineRows(links, link => typeof link.metadata.transitionEventId === "string" ? link.metadata.transitionEventId : null),
    byPractice: groupTimelineRows(links, link => link.practiceAttemptId),
    byEvidence: orderedTimelineGroups(links, link => link.evidenceId),
    byReview: orderedTimelineGroups(links, link => link.evidenceReviewId),
    byPlan: groupTimelineRows(links, link => link.remediationPlanId),
  };
}

/** Union two query-order groups, retaining the original filter(OR) order and uniqueness. */
export function unionTimelineGroups<T>(left: readonly OrderedTimelineRow<T>[], right: readonly OrderedTimelineRow<T>[]): T[] {
  const result: T[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const a = left[i];
    const b = right[j];
    if (b === undefined || (a !== undefined && a.position <= b.position)) {
      result.push(a!.row);
      i++;
      if (b?.position === a!.position) j++;
    } else {
      result.push(b.row);
      j++;
    }
  }
  return result;
}