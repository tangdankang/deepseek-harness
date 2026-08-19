import { AppError } from "./errors.mjs";

export const CaseStatus = Object.freeze({
  DRAFT: "DRAFT",
  WAITING_INFORMATION: "WAITING_INFORMATION",
  WAITING_CONFIRMATION: "WAITING_CONFIRMATION",
  SUBMITTING: "SUBMITTING",
  SUBMITTED: "SUBMITTED",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_USER: "WAITING_USER",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
  REJECTED: "REJECTED",
  SUBMIT_FAILED: "SUBMIT_FAILED",
  CANCELLED: "CANCELLED",
});

const transitions = new Map([
  [CaseStatus.DRAFT, new Set([CaseStatus.WAITING_INFORMATION, CaseStatus.WAITING_CONFIRMATION, CaseStatus.CANCELLED])],
  [CaseStatus.WAITING_INFORMATION, new Set([CaseStatus.DRAFT, CaseStatus.WAITING_CONFIRMATION, CaseStatus.CANCELLED])],
  [CaseStatus.WAITING_CONFIRMATION, new Set([CaseStatus.DRAFT, CaseStatus.WAITING_INFORMATION, CaseStatus.SUBMITTING, CaseStatus.CANCELLED])],
  [CaseStatus.SUBMITTING, new Set([CaseStatus.SUBMITTED, CaseStatus.SUBMIT_FAILED])],
  [CaseStatus.SUBMIT_FAILED, new Set([CaseStatus.SUBMITTING, CaseStatus.CANCELLED])],
  [CaseStatus.SUBMITTED, new Set([CaseStatus.IN_PROGRESS, CaseStatus.WAITING_USER, CaseStatus.RESOLVED, CaseStatus.CLOSED, CaseStatus.REJECTED])],
  [CaseStatus.IN_PROGRESS, new Set([CaseStatus.WAITING_USER, CaseStatus.RESOLVED, CaseStatus.CLOSED, CaseStatus.REJECTED])],
  [CaseStatus.WAITING_USER, new Set([CaseStatus.IN_PROGRESS, CaseStatus.RESOLVED, CaseStatus.CLOSED, CaseStatus.REJECTED])],
  [CaseStatus.RESOLVED, new Set([CaseStatus.CLOSED, CaseStatus.IN_PROGRESS])],
  [CaseStatus.CLOSED, new Set([])],
  [CaseStatus.CANCELLED, new Set([])],
  [CaseStatus.REJECTED, new Set([])],
]);

export function canTransition(from, to) {
  return from === to || Boolean(transitions.get(from)?.has(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new AppError("INVALID_STATUS_TRANSITION", `不允许从 ${from} 变更为 ${to}`, 409, { from, to });
  }
}
