import process from 'node:process';

import type { AcceptanceIssue, AcceptanceReport } from '../contracts/probe-acceptance.js';
import { HARNESS_VERSION } from '../contracts/probe-constants.js';
import type { CaseEvidence, GateEvidence, GateStatus, LiveEvidence, ProbeSummary } from '../contracts/probe-evidence.js';
import type { LiveSmokeResult, ProbeCaseResult, SafeError } from '../contracts/probe.js';
import { makeCaseEvidence } from '../trace/probe-evidence.js';
export function makeCaseFromResult(
  result: ProbeCaseResult,
  report: AcceptanceReport | undefined,
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
    verification: 'live',
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

export function issueDetail(issues: readonly AcceptanceIssue[], fallback: string): string {
  if (issues.length === 0) return fallback;
  return issues.slice(0, 3).map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}

interface SummaryBuildInput {
  readonly runId: string;
  readonly installedVersions: Readonly<Record<string, string>>;
  readonly lockfileSha256: string;
  readonly envError: SafeError | null;
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
  if (input.liveResult !== undefined) {
    cases.push(makeCaseFromResult(input.liveResult, input.liveReport));
  }

  const staticDetail = input.envError === null
    ? 'installed package metadata matches package-lock.json'
    : `environment gate blocked: ${input.envError.message}`;
  const gates: GateEvidence[] = [
    {
      name: 'static-versions',
      status: input.envError === null ? 'PASS' : 'BLOCKED',
      verification: 'static',
      detail: staticDetail,
    },
    input.liveGate,
  ];

  const notes = [
    ...input.notes,
    input.liveResult === undefined
      ? 'The LIVE case was not executed, so no provider requests are counted.'
      : 'Counters cover the LIVE case only; modelRequests are real provider requests.',
    'The live smoke permits only get_robot_status; no approval is requested or granted.',
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
    mode: 'live',
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
