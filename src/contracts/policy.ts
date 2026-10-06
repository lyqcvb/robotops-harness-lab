export const HARNESS_VERSION = '0.1.5-rc.3' as const;
export const DEFAULT_MODEL = 'deepseek-flash' as const;

export const DEFAULT_BUDGETS = Object.freeze({
  modelRequests: 20,
  toolCalls: 30,
  activeMs: 300_000,
  approvalMs: 120_000,
} as const);

export const ACTION_LIMITS = Object.freeze({
  restart_navigation: 2,
  force_reboot: 1,
} as const);

export const SOFT_STOP_REASONS = Object.freeze([
  'FAIL_FAST',
  'SOP_NOT_FOUND',
  'APPROVAL_REJECTED',
  'APPROVAL_REQUIRED',
  'APPROVAL_UNAVAILABLE',
] as const);

export function isSoftStopReason(reason: string | null): boolean {
  return (
    reason !== null &&
    (SOFT_STOP_REASONS as readonly string[]).includes(reason)
  );
}
