import {
  GateProgressStatus,
  type GateProgressStatus as CanonicalGateStatus,
} from "@workspace/api-client-react";

export type GateStatusPresentation = {
  label: string;
  badgeVariant: "success" | "default" | "destructive" | "secondary";
  state: "passed" | "active" | "blocked" | "locked";
  isPassed: boolean;
  isCurrent: boolean;
  isBlocked: boolean;
  isOpen: boolean;
};

export const gateStatusPresentationByStatus: Record<CanonicalGateStatus, GateStatusPresentation> = {
  [GateProgressStatus.PASSED]: {
    label: "PASSED",
    badgeVariant: "success",
    state: "passed",
    isPassed: true,
    isCurrent: false,
    isBlocked: false,
    isOpen: true,
  },
  [GateProgressStatus.ACTIVE]: {
    label: "ACTIVE",
    badgeVariant: "default",
    state: "active",
    isPassed: false,
    isCurrent: true,
    isBlocked: false,
    isOpen: true,
  },
  [GateProgressStatus.BLOCKED]: {
    label: "BLOCKED",
    badgeVariant: "destructive",
    state: "blocked",
    isPassed: false,
    isCurrent: true,
    isBlocked: true,
    isOpen: false,
  },
  [GateProgressStatus.LOCKED]: {
    label: "LOCKED",
    badgeVariant: "secondary",
    state: "locked",
    isPassed: false,
    isCurrent: false,
    isBlocked: false,
    isOpen: false,
  },
};

const unknownGateStatusPresentation: GateStatusPresentation = {
  label: "UNKNOWN — LOCKED",
  badgeVariant: "destructive",
  state: "locked",
  isPassed: false,
  isCurrent: false,
  isBlocked: true,
  isOpen: false,
};

export function getGateStatusPresentation(status: unknown): GateStatusPresentation {
  return typeof status === "string" && status in gateStatusPresentationByStatus
    ? gateStatusPresentationByStatus[status as CanonicalGateStatus]
    : unknownGateStatusPresentation;
}