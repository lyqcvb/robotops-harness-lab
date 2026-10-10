import type { GateStatus } from './probe-evidence.js';

import type { SafeError } from './shared.js';

export type { SafeError } from './shared.js';

export interface ProbeBudgets {
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly activeMs: number;
  readonly approvalMs: number;
}

export interface ProbeCaseResult {
  readonly id: string;
  readonly status: GateStatus;
  readonly modelRequests: number;
  readonly toolRequests: number;
  readonly actionExecutions: number;
  readonly approvalAsked: number;
  readonly approvalAllowedOnce: number;
  readonly executionsByName: Readonly<Record<string, number>>;
  readonly sessionId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly toolNames: readonly string[];
  readonly persistedEventCount: number;
  readonly nativeEvents: readonly unknown[];
  readonly probeEvents: readonly unknown[];
  readonly notes: readonly string[];
  readonly error: SafeError | null;
}

export interface LiveSmokeResult extends ProbeCaseResult {
  readonly liveCalledGetRobotStatus: boolean;
  readonly liveToolResultReadable: boolean;
}
