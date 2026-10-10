import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CaseEvidence, EvidenceBundleInput, GateStatus, RunPaths, VerificationKind } from '../contracts/probe-evidence.js';
import { redactValue } from './redaction.js';

export { redactValue, safeError } from './redaction.js';
export { readInstalledVersions, readLockfileDigest } from './environment.js';

export function createRunPaths(projectRoot: string, now = new Date()): RunPaths {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runId = `${stamp}-live-${randomUUID()}`;
  const evidenceRoot = path.resolve(projectRoot, 'evidence', 'stage0');
  return {
    runId,
    evidenceRoot,
    evidenceDir: path.join(evidenceRoot, runId),
    persistenceRoot: path.resolve(projectRoot, '.stage0', runId),
  };
}

export async function writeEvidenceBundle(input: EvidenceBundleInput): Promise<string> {
  const secrets = input.redactionSecrets ?? [];
  const evidenceRoot = path.resolve(input.projectRoot, 'evidence', 'stage0');
  const evidenceDir = path.join(evidenceRoot, input.runId);
  await mkdir(evidenceRoot, { recursive: true });
  await mkdir(evidenceDir);

  const nativeLines = input.nativeEvents.map((event) => JSON.stringify(redactValue(event, secrets)));
  const probeLines = input.probeEvents.map((event) => JSON.stringify(redactValue(event, secrets)));
  const summary = redactValue(input.summary, secrets);

  await writeFile(path.join(evidenceDir, 'native-events.jsonl'), `${nativeLines.join('\n')}${nativeLines.length > 0 ? '\n' : ''}`, { flag: 'wx' });
  await writeFile(path.join(evidenceDir, 'probe-events.jsonl'), `${probeLines.join('\n')}${probeLines.length > 0 ? '\n' : ''}`, { flag: 'wx' });
  await writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
  return evidenceDir;
}

export function makeProbeEvent(
  event: string,
  runId: string,
  data: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    schema_version: 1,
    event,
    run_id: runId,
    time: new Date().toISOString(),
    ...data,
  };
}

export function makeCaseEvidence(input: {
  readonly id: string;
  readonly status: GateStatus;
  readonly verification: VerificationKind;
  readonly sessionId?: string | null;
  readonly modelRequests: number;
  readonly toolRequests: number;
  readonly actionExecutions: number;
  readonly approvalAsked: number;
  readonly approvalAllowedOnce: number;
  readonly notes?: readonly string[];
}): CaseEvidence {
  return {
    id: input.id,
    status: input.status,
    verification: input.verification,
    sessionId: input.sessionId ?? null,
    modelRequests: input.modelRequests,
    toolRequests: input.toolRequests,
    actionExecutions: input.actionExecutions,
    approvalAsked: input.approvalAsked,
    approvalAllowedOnce: input.approvalAllowedOnce,
    notes: input.notes ?? [],
  };
}

