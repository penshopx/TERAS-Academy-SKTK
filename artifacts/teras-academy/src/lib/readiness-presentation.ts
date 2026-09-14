import {
  ReadinessSummaryStatus,
  type ReadinessSummaryStatus as ReadinessStatus,
} from "@workspace/api-client-react";
import type { BadgeProps } from "@/components/ui/badge";

export type ReadinessSafetyState = "CLEAR" | "BLOCKED" | "NOT CLEARED";

type ReadinessPresentation = {
  label: string;
  badgeVariant: NonNullable<BadgeProps["variant"]>;
  scoreClassName: string;
  safetyState: ReadinessSafetyState;
  isReady: boolean;
};

export const readinessPresentationByStatus = {
  [ReadinessSummaryStatus.Not_Ready]: {
    label: ReadinessSummaryStatus.Not_Ready,
    badgeVariant: "destructive",
    scoreClassName: "text-destructive",
    safetyState: "BLOCKED",
    isReady: false,
  },
  [ReadinessSummaryStatus.Developing]: {
    label: ReadinessSummaryStatus.Developing,
    badgeVariant: "warning",
    scoreClassName: "text-amber-500",
    safetyState: "NOT CLEARED",
    isReady: false,
  },
  [ReadinessSummaryStatus.Ready_for_Official_Assessment]: {
    label: ReadinessSummaryStatus.Ready_for_Official_Assessment,
    badgeVariant: "success",
    scoreClassName: "text-green-500",
    safetyState: "CLEAR",
    isReady: true,
  },
} satisfies Record<ReadinessStatus, ReadinessPresentation>;

const unknownReadinessPresentation: ReadinessPresentation = {
  label: "Status kesiapan tidak dikenal",
  badgeVariant: "warning",
  scoreClassName: "text-amber-500",
  safetyState: "NOT CLEARED",
  isReady: false,
};

export function getReadinessPresentation(status: unknown): ReadinessPresentation {
  return typeof status === "string" && Object.hasOwn(readinessPresentationByStatus, status)
    ? readinessPresentationByStatus[status as ReadinessStatus]
    : unknownReadinessPresentation;
}