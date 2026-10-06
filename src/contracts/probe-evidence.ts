export type VerificationKind = 'static' | 'offline' | 'live';
export type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';

export interface GateEvidence {
  readonly name: string;
  readonly status: GateStatus;
  readonly verification: VerificationKind;
  readonly detail?: string;
}

export interface CaseEvidence {
  readonly id: string;
  readonly status: GateStatus;
  readonly verification: VerificationKind;
  readonly sessionId: string | null;
  readonly modelRequests: number;
  readonly toolRequests: number;
  readonly actionExecutions: number;
  readonly approvalAsked: number;
  readonly approvalAllowedOnce: number;
  readonly notes: readonly string[];
}

export interface LiveEvidence {
  readonly status: GateStatus;
  readonly provider: string;
  readonly model: string;
  readonly detail?: string;
}

export interface ProbeSummary {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly node: string;
  readonly harnessVersion: string;
  readonly installedVersions: Readonly<Record<string, string>>;
  readonly lockfileSha256: string;
  readonly mode: 'offline' | 'live';
  readonly status: GateStatus;
  readonly stage0Complete: boolean;
  readonly gates: readonly GateEvidence[];
  readonly cases: readonly CaseEvidence[];
  readonly live: LiveEvidence;
  readonly counters: {
    readonly modelRequests: number;
    readonly toolRequests: number;
    readonly actionExecutions: number;
    readonly approvalAsked: number;
    readonly approvalAllowedOnce: number;
  };
  readonly blocked: readonly string[];
  readonly notes: readonly string[];
}

export interface EvidenceBundleInput {
  readonly projectRoot: string;
  readonly runId: string;
  readonly nativeEvents: readonly unknown[];
  readonly probeEvents: readonly unknown[];
  readonly summary: ProbeSummary;
  readonly redactionSecrets?: readonly string[];
}

export interface RunPaths {
  readonly runId: string;
  readonly evidenceRoot: string;
  readonly evidenceDir: string;
  readonly persistenceRoot: string;
}
