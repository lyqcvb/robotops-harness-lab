import process from 'node:process';

import type { AcceptanceIssue, AcceptanceReport } from '../contracts/probe-acceptance.js';
import { HARNESS_VERSION } from '../contracts/probe-constants.js';
import type { CaseEvidence, GateEvidence, GateStatus, LiveEvidence, ProbeSummary } from '../contracts/probe-evidence.js';
import type { LiveSmokeResult, ProbeCaseResult, ProbeExecutionResult, SafeError } from '../contracts/probe.js';
import { makeCaseEvidence } from '../trace/probe-evidence.js';
export function makeCaseFromResult(
  result: ProbeCaseResult,
  report: AcceptanceReport | undefined,
  verification: 'offline' | 'live',
): CaseEvidence {
  const caseReport = report?.cases.find((item) => item.caseId === result.id);
  const acceptanceIssues = caseReport?.issues ?? [];
  const notes = [...result.notes, ...acceptanceIssues.map((issue) => `acceptance ${issue.code}: ${issue.message}`)];
  let status: GateStatus;
  if (result.status === 'BLOCKED') {
    status = 'BLOCKED';
  } else if (result.status !== 'PASS') {
    status = result.status;
  } else if (caseReport !== undefined && acceptanceIssues.length === 0) {
    status = 'PASS';
  } else {
    status = 'FAIL';
    if (caseReport === undefined) notes.push('acceptance report unavailable; runtime PASS is insufficient');
  }
  return makeCaseEvidence({
    id: result.id,
    status,
    verification,
    sessionId: result.sessionId,
    modelRequests: result.modelRequests,
    toolRequests: result.toolRequests,
    actionExecutions: result.actionExecutions,
    approvalAsked: result.approvalAsked,
    approvalAllowedOnce: result.approvalAllowedOnce,
    notes,
  });
}

function sumCaseEvidence(cases: readonly CaseEvidence[]): ProbeSummary['counters'] {
  return cases.reduce((total, item) => ({
    modelRequests: total.modelRequests + item.modelRequests,
    toolRequests: total.toolRequests + item.toolRequests,
    actionExecutions: total.actionExecutions + item.actionExecutions,
    approvalAsked: total.approvalAsked + item.approvalAsked,
    approvalAllowedOnce: total.approvalAllowedOnce + item.approvalAllowedOnce,
  }), {
    modelRequests: 0,
    toolRequests: 0,
    actionExecutions: 0,
    approvalAsked: 0,
    approvalAllowedOnce: 0,
  });
}

function categoryStatus(
  report: AcceptanceReport | undefined,
  category: AcceptanceIssue['category'],
  fallback: GateStatus,
): GateStatus {
  if (report === undefined) return fallback;
  return report.issues.some((issue) => issue.category === category) ? 'FAIL' : 'PASS';
}

export function issueDetail(issues: readonly AcceptanceIssue[], fallback: string): string {
  if (issues.length === 0) return fallback;
  return issues.slice(0, 3).map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}

interface SummaryBuildInput {
  readonly runId: string;
  readonly mode: 'offline' | 'live';
  readonly installedVersions: Readonly<Record<string, string>>;
  readonly lockfileSha256: string;
  readonly envError: SafeError | null;
  readonly offlineResult?: ProbeExecutionResult;
  readonly offlineReport?: AcceptanceReport;
  readonly offlineRuntimeError: SafeError | null;
  readonly liveResult?: LiveSmokeResult;
  readonly liveReport?: AcceptanceReport;
  readonly liveGate: GateEvidence;
  readonly liveEvidence: LiveEvidence;
  readonly status: GateStatus;
  readonly stage0Complete: boolean;
  readonly blocked: readonly string[];
  readonly notes: readonly string[];
}

export function buildSummary(input: SummaryBuildInput): ProbeSummary {
  const cases: CaseEvidence[] = [];
  if (input.offlineResult !== undefined) {
    for (const item of input.offlineResult.cases) {
      cases.push(makeCaseFromResult(item, input.offlineReport, 'offline'));
    }
  }
  if (input.liveResult !== undefined) {
    cases.push(makeCaseFromResult(input.liveResult, input.liveReport, 'live'));
  }

  const offlineFallback: GateStatus = input.envError !== null ? 'NOT_RUN' : 'FAIL';
  const staticDetail = input.envError === null
    ? 'installed package metadata matches package-lock.json'
    : `environment gate blocked: ${input.envError.message}`;
  const offlineFallbackDetail = input.envError !== null
    ? 'offline suite was not run because the static environment gate is blocked'
    : input.offlineRuntimeError?.message ?? 'offline suite did not produce an acceptance report';
  const gates: GateEvidence[] = [
    {
      name: 'static-versions',
      status: input.envError === null ? 'PASS' : 'BLOCKED',
      verification: 'static',
      detail: staticDetail,
    },
    {
      name: 'offline-whitelist',
      status: categoryStatus(input.offlineReport, 'whitelist', offlineFallback),
      verification: 'offline',
      detail: input.offlineReport === undefined
        ? offlineFallbackDetail
        : issueDetail(input.offlineReport.issues.filter((issue) => issue.category === 'whitelist'), 'seven-tool whitelist acceptance passed'),
    },
    {
      name: 'offline-safety',
      status: categoryStatus(input.offlineReport, 'safety', offlineFallback),
      verification: 'offline',
      detail: input.offlineReport === undefined
        ? offlineFallbackDetail
        : issueDetail(input.offlineReport.issues.filter((issue) => issue.category === 'safety'), 'offline approval and execution safety acceptance passed'),
    },
    {
      name: 'offline-persistence',
      status: categoryStatus(input.offlineReport, 'persistence', offlineFallback),
      verification: 'offline',
      detail: input.offlineReport === undefined
        ? offlineFallbackDetail
        : issueDetail(input.offlineReport.issues.filter((issue) => issue.category === 'persistence'), 'native event pairing and JSONL persistence acceptance passed'),
    },
    input.liveGate,
  ];

  const counterScope = input.mode === 'offline'
    ? 'Counters cover scripted offline probe cases only; modelRequests are scripted adapter requests, not live API calls.'
    : input.liveResult === undefined
      ? 'Counters cover scripted offline probe cases only; the LIVE case was not executed, so no live API calls are counted.'
      : 'Counters cover scripted offline probe cases plus the LIVE case; only the LIVE modelRequests value represents real provider requests.';
  const notes = [
    ...input.notes,
    counterScope,
    'Approval decisions in these runs are scripted Stage 0 harness evidence, not human approvals.',
    'Probe tools use stub counters only: no robot state, task, ticket, or other business side effect was produced or claimed.',
  ];

  return {
    schemaVersion: 1,
    runId: input.runId,
    generatedAt: new Date().toISOString(),
    node: process.version,
    harnessVersion: HARNESS_VERSION,
    installedVersions: input.installedVersions,
    lockfileSha256: input.lockfileSha256,
    mode: input.mode,
    status: input.status,
    stage0Complete: input.stage0Complete,
    gates,
    cases,
    live: input.liveEvidence,
    counters: sumCaseEvidence(cases),
    blocked: input.blocked,
    notes,
  };
}
