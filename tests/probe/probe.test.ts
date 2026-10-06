import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test, { before } from 'node:test';
import {
  evaluateCaseAcceptance,
  evaluateDefaultOfflineAcceptance,
} from '../../src/eval/probe-acceptance.js';
import {
  readInstalledVersions,
  readLockfileDigest,
  redactValue,
  safeError,
  writeEvidenceBundle,
} from '../../src/trace/probe-evidence.js';
import { executeOfflineSecurityCases } from '../../src/harness/probe-runtime.js';
import type {
  ProbeCaseDefinition,
  ProbeCaseResult,
  ProbeExecutionResult,
} from '../../src/contracts/probe.js';
import type { ProbeSummary } from '../../src/contracts/probe-evidence.js';
import type { AcceptanceReport } from '../../src/contracts/probe-acceptance.js';
import { toolCall } from '../../src/harness/probe-scenarios.js';
import { makeCaseFromResult } from '../../src/eval/probe-report.js';

const projectRoot = process.cwd();
const customDefinitions: readonly ProbeCaseDefinition[] = [
  {
    id: 'tool-budget',
    prompt: 'Attempt two reads with a one-call tool budget.',
    turns: [
      { kind: 'tool-calls', calls: [
        toolCall('tool-budget-1', 'get_robot_status', { robot_id: 'R-03' }),
        toolCall('tool-budget-2', 'get_robot_status', { robot_id: 'R-03' }),
      ] },
      { kind: 'text', text: 'tool budget complete' },
    ],
    approvalMode: 'unavailable',
    budgets: { toolCalls: 1 },
  },
  {
    id: 'model-budget',
    prompt: 'Attempt a second model request with a one-request budget.',
    turns: [
      { kind: 'tool-calls', calls: [toolCall('model-budget-1', 'get_robot_status', { robot_id: 'R-03' })] },
      { kind: 'text', text: 'model budget complete' },
    ],
    approvalMode: 'unavailable',
    budgets: { modelRequests: 1 },
  },
  {
    id: 'restart-budget',
    prompt: 'Attempt restart_navigation three times.',
    turns: [
      { kind: 'tool-calls', calls: [toolCall('restart-1', 'restart_navigation', { robot_id: 'R-03' })] },
      { kind: 'tool-calls', calls: [toolCall('restart-2', 'restart_navigation', { robot_id: 'R-03' })] },
      { kind: 'tool-calls', calls: [toolCall('restart-3', 'restart_navigation', { robot_id: 'R-03' })] },
      { kind: 'text', text: 'restart budget complete' },
    ],
    approvalMode: 'unavailable',
  },
  {
    id: 'replay',
    prompt: 'Replay the same tool call identity.',
    turns: [
      { kind: 'tool-calls', calls: [toolCall('replay-1', 'get_robot_status', { robot_id: 'R-03' })] },
      { kind: 'tool-calls', calls: [toolCall('replay-1', 'get_robot_status', { robot_id: 'R-03' })] },
      { kind: 'text', text: 'replay complete' },
    ],
    approvalMode: 'unavailable',
  },
  {
    id: 'isolate',
    prompt: 'Use one approved force_reboot call.',
    turns: [
      { kind: 'tool-calls', calls: [toolCall('isolate-1', 'force_reboot', { robot_id: 'R-03' })] },
      { kind: 'text', text: 'isolation complete' },
    ],
    approvalMode: 'approve-once',
  },
];

let defaultResult: ProbeExecutionResult;
let defaultReport: AcceptanceReport;
let customResult: ProbeExecutionResult;
let isolatedResults: readonly ProbeCaseResult[];

function requireCase(result: ProbeExecutionResult, id: string): ProbeCaseResult {
  const found = result.cases.find((item) => item.id === id);
  assert.ok(found, `missing case ${id}`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventType(event: unknown): string | null {
  return isRecord(event) && typeof event.type === 'string' ? event.type : null;
}

function probeCount(caseResult: ProbeCaseResult, eventName: string): number {
  return caseResult.probeEvents.filter((event) => isRecord(event) && event.event === eventName).length;
}

function nativeCallIds(caseResult: ProbeCaseResult): readonly string[] {
  return caseResult.nativeEvents
    .filter((event) => eventType(event) === 'tool/call')
    .flatMap((event) => isRecord(event) && isRecord(event.data) && typeof event.data.callId === 'string' ? [event.data.callId] : []);
}

function approvalOutcomes(caseResult: ProbeCaseResult): readonly string[] {
  return caseResult.nativeEvents
    .filter((event) => eventType(event) === 'approval/decided')
    .flatMap((event) => isRecord(event) && isRecord(event.data) && typeof event.data.outcome === 'string' ? [event.data.outcome] : []);
}

before(async () => {
  defaultResult = await executeOfflineSecurityCases(projectRoot, `test-${randomUUID()}`);
  defaultReport = evaluateDefaultOfflineAcceptance(defaultResult);
  customResult = await executeOfflineSecurityCases(projectRoot, `test-${randomUUID()}`, customDefinitions);
  const isolateDefinition = customDefinitions[4];
  assert.ok(isolateDefinition, 'isolate definition is missing');
  const isolatedA = await executeOfflineSecurityCases(projectRoot, `test-${randomUUID()}`, [isolateDefinition]);
  const isolatedB = await executeOfflineSecurityCases(projectRoot, `test-${randomUUID()}`, [isolateDefinition]);
  isolatedResults = [requireCase(isolatedA, 'isolate'), requireCase(isolatedB, 'isolate')];
});

test('default offline suite passes independent acceptance', () => {
  assert.equal(defaultReport.passed, true, JSON.stringify(defaultReport.issues, null, 2));
  assert.deepEqual(defaultResult.cases.map((item) => item.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G-cancelled', 'G-expired', 'H']);
  assert.equal(defaultResult.counters.toolRequests, 10);
  assert.equal(defaultResult.counters.actionExecutions, 2);
  assert.equal(defaultResult.counters.approvalAsked, 5);
  assert.equal(defaultResult.counters.approvalAllowedOnce, 2);
});

test('A executes get_robot_status once with a readable success handler', () => {
  const caseResult = requireCase(defaultResult, 'A');
  assert.equal(caseResult.modelRequests, 2);
  assert.equal(caseResult.toolRequests, 1);
  assert.equal(caseResult.actionExecutions, 1);
  assert.deepEqual(caseResult.executionsByName, { get_robot_status: 1 });
  assert.deepEqual(nativeCallIds(caseResult), ['call-a-1']);
  assert.equal(probeCount(caseResult, 'PROBE_ACTION_EXECUTED'), 1);
});

test('B rejects the unknown shell request without executing it', () => {
  const caseResult = requireCase(defaultResult, 'B');
  assert.equal(caseResult.toolRequests, 1);
  assert.equal(caseResult.actionExecutions, 0);
  assert.deepEqual(caseResult.executionsByName, {});
  assert.deepEqual(nativeCallIds(caseResult), ['call-b-1']);
  assert.equal(probeCount(caseResult, 'PROBE_ACTION_EXECUTED'), 0);
});

test('C and D fail closed for unavailable and rejected approval', () => {
  const unavailable = requireCase(defaultResult, 'C');
  const rejected = requireCase(defaultResult, 'D');
  assert.equal(unavailable.actionExecutions, 0);
  assert.equal(unavailable.approvalAsked, 1);
  assert.deepEqual(approvalOutcomes(unavailable), ['unavailable']);
  assert.equal(rejected.actionExecutions, 0);
  assert.equal(rejected.approvalAsked, 1);
  assert.deepEqual(approvalOutcomes(rejected), ['rejected']);
});

test('E consumes one approval for one of two distinct force calls', () => {
  const caseResult = requireCase(defaultResult, 'E');
  const callIds = nativeCallIds(caseResult);
  assert.equal(caseResult.toolRequests, 2);
  assert.equal(new Set(callIds).size, 2);
  assert.equal(caseResult.actionExecutions, 1);
  assert.equal(caseResult.approvalAllowedOnce, 1);
  assert.equal(probeCount(caseResult, 'PROBE_APPROVAL_CONSUMED'), 1);
  assert.deepEqual(caseResult.executionsByName, { force_reboot: 1 });
});

test('F rejects forged approved=true input without granting authorization', () => {
  const caseResult = requireCase(defaultResult, 'F');
  assert.equal(caseResult.toolRequests, 1);
  assert.equal(caseResult.actionExecutions, 0);
  assert.equal(caseResult.approvalAllowedOnce, 0);
  assert.deepEqual(approvalOutcomes(caseResult), []);
  assert.equal(probeCount(caseResult, 'PROBE_APPROVAL_CONSUMED'), 0);
});

test('G cancellation and expiry decisions never execute force_reboot', () => {
  const cancelled = requireCase(defaultResult, 'G-cancelled');
  const expired = requireCase(defaultResult, 'G-expired');
  assert.equal(cancelled.actionExecutions, 0);
  assert.deepEqual(approvalOutcomes(cancelled), ['cancelled']);
  assert.equal(expired.actionExecutions, 0);
  assert.equal(expired.approvalAllowedOnce, 1);
  assert.deepEqual(approvalOutcomes(expired), ['allowed-once']);
  assert.equal(probeCount(expired, 'PROBE_APPROVAL_CONSUMED'), 0);
});

test('H pre-execute fixture cannot bypass the final authorization guard', () => {
  const caseResult = requireCase(defaultResult, 'H');
  assert.equal(caseResult.toolRequests, 1);
  assert.equal(caseResult.actionExecutions, 0);
  assert.equal(caseResult.approvalAsked, 0);
  assert.equal(caseResult.approvalAllowedOnce, 0);
  assert.deepEqual(approvalOutcomes(caseResult), []);
});

test('tool budget counts attempts but executes at most one call', () => {
  const caseResult = requireCase(customResult, 'tool-budget');
  const report = evaluateCaseAcceptance(caseResult, {
    id: 'tool-budget',
    toolRequests: { exact: 2 },
    actionExecutions: { exact: 1 },
    tools: [{ name: 'get_robot_status', total: { exact: 2 }, success: { exact: 1 }, error: { exact: 1 } }],
    executionsByName: { get_robot_status: { exact: 1 } },
    probeEventCounts: { PROBE_BUDGET_EXCEEDED: { min: 1 } },
  });
  assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
  assert.equal(caseResult.actionExecutions, 1);
});

test('model budget counts only dispatched requests, not blocked attempts', () => {
  const caseResult = requireCase(customResult, 'model-budget');
  const report = evaluateCaseAcceptance(caseResult, {
    id: 'model-budget',
    modelRequests: { exact: 1 },
    toolRequests: { exact: 1 },
    actionExecutions: { exact: 1 },
    tools: [{ name: 'get_robot_status', total: { exact: 1 }, success: { exact: 1 }, error: { exact: 0 } }],
    executionsByName: { get_robot_status: { exact: 1 } },
    probeEventCounts: { PROBE_BUDGET_EXCEEDED: { min: 1 } },
  });
  assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
  const budgetEvent = caseResult.probeEvents.find((event) => isRecord(event) && event.event === 'PROBE_BUDGET_EXCEEDED');
  assert.ok(budgetEvent && isRecord(budgetEvent));
  assert.equal(budgetEvent.attempted, 2);
  assert.equal(budgetEvent.dispatched, 1);
});

test('restart_navigation stops after two real executions', () => {
  const caseResult = requireCase(customResult, 'restart-budget');
  const report = evaluateCaseAcceptance(caseResult, {
    id: 'restart-budget',
    toolRequests: { exact: 3 },
    actionExecutions: { exact: 2 },
    tools: [{ name: 'restart_navigation', total: { exact: 3 }, success: { exact: 2 }, error: { exact: 1 } }],
    executionsByName: { restart_navigation: { exact: 2 } },
  });
  assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
});

test('same callId replay does not execute twice', () => {
  const caseResult = requireCase(customResult, 'replay');
  const report = evaluateCaseAcceptance(caseResult, {
    id: 'replay',
    toolRequests: { exact: 2 },
    actionExecutions: { exact: 1 },
    tools: [{ name: 'get_robot_status', total: { exact: 2 }, success: { exact: 1 }, error: { exact: 1 } }],
    executionsByName: { get_robot_status: { exact: 1 } },
  });
  assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
  assert.deepEqual(nativeCallIds(caseResult), ['replay-1', 'replay-1']);
});

test('authorization state does not carry into an independent run', () => {
  assert.equal(isolatedResults.length, 2);
  for (const caseResult of isolatedResults) {
    const report = evaluateCaseAcceptance(caseResult, {
      id: 'isolate',
      toolRequests: { exact: 1 },
      actionExecutions: { exact: 1 },
      tools: [{ name: 'force_reboot', total: { exact: 1 }, success: { exact: 1 }, error: { exact: 0 } }],
      executionsByName: { force_reboot: { exact: 1 } },
      approval: { asked: { exact: 1 }, allowedOnce: { exact: 1 }, outcomes: ['allowed-once'] },
      probeEventCounts: { PROBE_APPROVAL_CONSUMED: { exact: 1 } },
    });
    assert.equal(report.issues.length, 0, JSON.stringify(report.issues));
  }
  const first = isolatedResults[0];
  const second = isolatedResults[1];
  assert.ok(first && second);
  assert.notEqual(first.sessionId, second.sessionId);
});

test('reads real installed versions and matches them to the lockfile', async () => {
  const versions = await readInstalledVersions(projectRoot);
  const expected: Readonly<Record<string, string>> = {
    '@deepseek-ai/cordis': '4.0.2',
    '@deepseek-ai/dsh-agent': '0.1.5-rc.3',
    '@deepseek-ai/dsh-agent-loop': '0.1.5-rc.3',
    '@deepseek-ai/dsh-llm': '0.1.5-rc.3',
    '@deepseek-ai/dsh-llm-deepseek': '0.1.5-rc.3',
    '@deepseek-ai/dsh-scope': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-persistence-jsonl': '0.1.5-rc.3',
    '@deepseek-ai/dsh-session-projection': '0.1.5-rc.3',
    '@deepseek-ai/dsh-system-prompt': '0.1.5-rc.3',
    '@deepseek-ai/dsh-tools': '0.1.5-rc.3',
    '@deepseek-ai/dsh-user-approval': '0.1.5-rc.3',
  };
  assert.deepEqual(versions, expected);
  assert.equal(Object.hasOwn(versions, '@example/not-installed'), false);
  assert.match(await readLockfileDigest(projectRoot), /^sha256:[a-f0-9]{64}$/);
});

test('redacts fake secrets, authorization values, and nested secret fields', () => {
  const secret = 'sk-test-only-1234567890';
  const value = {
    api_key: secret,
    authorization: `Bearer ${secret}`,
    nested: {
      token: secret,
      note: `Authorization: Bearer ${secret}`,
    },
  };
  const serialized = JSON.stringify(redactValue(value, [secret]));
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[REDACTED\]/);
  const error = safeError(new Error(`request failed Authorization: Bearer ${secret}`), [secret]);
  assert.equal(error.message.includes(secret), false);
  assert.match(error.message, /\[REDACTED\]/);
});

interface ChildResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function readJsonLines(filePath: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const contents = await readFile(filePath, 'utf8');
  return contents
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(isRecord(parsed), `expected JSON object in ${filePath}`);
      return parsed;
    });
}

function runNode(args: readonly string[], env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('live CLI without credentials exits BLOCKED before any provider call', async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
  };
  delete env.DEEPSEEK_API_KEY;
  const child = await runNode([path.resolve(projectRoot, 'build/scripts/probe.js'), '--live'], env);
  assert.equal(child.code, 2, `stderr=${child.stderr}`);
  const lines = child.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const outputText = lines[lines.length - 1];
  assert.ok(outputText, `missing CLI output: ${child.stdout}`);
  const output: unknown = JSON.parse(outputText);
  assert.ok(isRecord(output));
  assert.equal(output.status, 'BLOCKED');
  assert.equal(output.stage0Complete, false);
  assert.equal(typeof output.evidenceDir, 'string');
  const evidenceDir = String(output.evidenceDir);
  const summary: unknown = JSON.parse(await readFile(path.join(evidenceDir, 'summary.json'), 'utf8'));
  assert.ok(isRecord(summary));
  assert.equal(summary.status, 'BLOCKED');
  assert.equal(summary.stage0Complete, false);
  assert.ok(isRecord(summary.live));
  assert.equal(summary.live.status, 'BLOCKED');
  assert.equal(summary.live.provider, '');
  assert.ok(Array.isArray(summary.blocked));
  assert.match(summary.blocked.join(' '), /DEEPSEEK_API_KEY/);

  for (const fileName of ['native-events.jsonl', 'probe-events.jsonl']) {
    const rows = await readJsonLines(path.join(evidenceDir, fileName));
    assert.ok(rows.length > 0, `${fileName} should contain evidence rows`);
    const batchSequences = rows.map((row) => row.batch_sequence);
    assert.deepEqual(
      batchSequences,
      rows.map((_, index) => index + 1),
      `${fileName} batch_sequence must be globally continuous`,
    );
    assert.equal(new Set(batchSequences).size, rows.length, `${fileName} batch_sequence must not repeat`);
  }
});

test('summary case status becomes FAIL when independent evidence is incomplete', () => {
  const original = requireCase(defaultResult, 'A');
  const tampered: ProbeCaseResult = {
    ...original,
    nativeEvents: original.nativeEvents.filter((event) => eventType(event) !== 'tool/result'),
  };
  const caseReport = evaluateCaseAcceptance(tampered, {
    id: 'A',
    toolRequests: { exact: 1 },
    actionExecutions: { exact: 1 },
    tools: [{ name: 'get_robot_status', total: { exact: 1 }, success: { exact: 1 }, error: { exact: 0 } }],
    executionsByName: { get_robot_status: { exact: 1 } },
  });
  assert.ok(caseReport.issues.length > 0, 'tampered fixture must fail independent acceptance');
  const report: AcceptanceReport = {
    passed: false,
    issues: caseReport.issues,
    cases: [caseReport],
  };
  const evidence = makeCaseFromResult(tampered, report, 'offline');
  assert.equal(evidence.status, 'FAIL');
  assert.match(evidence.notes.join('\n'), /acceptance (native-tool-pairing|execution-without-success-handler|success-handler-without-execution)/);

  const blocked = makeCaseFromResult({ ...tampered, status: 'BLOCKED' }, report, 'offline');
  assert.equal(blocked.status, 'BLOCKED');
});





test('redaction preserves own __proto__ JSON fields and normal prototypes at every depth', () => {
  const fixtures = [
    { value: { audit_marker: 'keep', password: 'fake-password', token: 'fake-token' }, expected: { audit_marker: 'keep', password: '[REDACTED]', token: '[REDACTED]' } },
    { value: 'keep fake-explicit-secret', expected: 'keep [REDACTED]' },
    { value: null, expected: null },
  ];
  for (const { value, expected } of fixtures) {
    const encoded = JSON.stringify(value);
    const input: unknown = JSON.parse('{"__proto__":' + encoded + ',"nested":{"__proto__":' + encoded + '}}');
    const output = redactValue(input, ['fake-explicit-secret']);
    assert.ok(isRecord(output) && isRecord(output.nested));
    for (const record of [output, output.nested]) {
      assert.equal(Object.getPrototypeOf(record), Object.prototype);
      assert.equal(Object.hasOwn(record, '__proto__'), true);
      assert.equal(Object.getOwnPropertyDescriptor(record, '__proto__')?.enumerable, true);
      assert.deepEqual(record.__proto__, expected);
    }
    const serialized = JSON.stringify(output);
    for (const secret of ['fake-password', 'fake-token', 'fake-explicit-secret']) {
      assert.equal(serialized.includes(secret), false);
    }
    const roundTrip: unknown = JSON.parse(serialized);
    assert.deepEqual(roundTrip, output);
  }
});

test('evidence bundle serialization retains own __proto__ fields while redacting children', async () => {
  const payload: unknown = JSON.parse('{"__proto__":{"audit_marker":"keep","password":"fake-password"},"nested":{"__proto__":{"robot_id":"R-03","token":"fake-token"}}}');
  assert.ok(isRecord(payload));
  const runId = 'redaction-test-' + randomUUID();
  const summary: ProbeSummary = {
    schemaVersion: 1, runId, generatedAt: '2026-09-26T00:00:00.000Z', node: process.version,
    harnessVersion: 'test', installedVersions: {}, lockfileSha256: '', mode: 'offline',
    status: 'PASS', stage0Complete: false, gates: [], cases: [],
    live: { status: 'NOT_RUN', provider: '', model: '' },
    counters: { modelRequests: 0, toolRequests: 0, actionExecutions: 0, approvalAsked: 0, approvalAllowedOnce: 0 },
    blocked: [], notes: [],
    ...payload,
  };
  const directory = await writeEvidenceBundle({ projectRoot, runId, nativeEvents: [payload], probeEvents: [payload], summary });
  for (const fileName of ['native-events.jsonl', 'probe-events.jsonl', 'summary.json']) {
    const serialized = await readFile(path.join(directory, fileName), 'utf8');
    const parsed: unknown = JSON.parse(serialized);
    assert.ok(isRecord(parsed) && isRecord(parsed.nested));
    assert.equal(Object.hasOwn(parsed, '__proto__'), true, fileName);
    assert.deepEqual(parsed.__proto__, { audit_marker: 'keep', password: '[REDACTED]' });
    assert.equal(Object.hasOwn(parsed.nested, '__proto__'), true, fileName);
    assert.deepEqual(parsed.nested.__proto__, { robot_id: 'R-03', token: '[REDACTED]' });
    assert.equal(serialized.includes('fake-password'), false);
    assert.equal(serialized.includes('fake-token'), false);
  }
});

test('redaction and safeError remove complete Authorization credentials without consuming other text', () => {
  const credential = Buffer.from('fake-user:fake-password').toString('base64');
  for (const prefix of ['Authorization: Basic ', 'aUtHoRiZaTiOn\t=\tbAsIc\t', 'Authorization: Bearer ', 'Authorization=']) {
    const input = prefix + credential + ' keep-suffix\nkeep-next-line';
    const output = redactValue({ note: input });
    assert.ok(isRecord(output) && typeof output.note === 'string');
    for (const result of [output.note, safeError(new Error(input)).message]) {
      assert.equal(result.includes(credential), false, prefix);
      assert.match(result, /\[REDACTED\]/);
      assert.ok(result.endsWith(' keep-suffix\nkeep-next-line'));
    }
  }
  for (const input of ['Authorization:\nkeep-next-line', 'Authorization\nkeep-next-line', 'Bearer\nkeep-next-line']) {
    assert.ok(String(redactValue(input)).endsWith('\nkeep-next-line'));
    assert.ok(safeError(new Error(input)).message.endsWith('\nkeep-next-line'));
  }
});

function forceEvidenceRecords(events: readonly unknown[], field: 'type' | 'event', value: string): Record<string, unknown> {
  const event = events.find((item) => isRecord(item) && item[field] === value);
  assert.ok(isRecord(event), 'missing ' + value);
  return event;
}

const forceEvidenceMutations: readonly [string, (native: unknown[], probe: unknown[]) => void][] = [
  ['approved callId differs', (native) => {
    const asked = forceEvidenceRecords(native, 'type', 'approval/asked');
    assert.ok(isRecord(asked.data));
    asked.data.callId = 'unapproved-other-call';
  }],
  ['consumed call_id differs', (_native, probe) => {
    forceEvidenceRecords(probe, 'event', 'PROBE_APPROVAL_CONSUMED').call_id = 'other-call';
  }],
  ['ask session differs', (native) => {
    forceEvidenceRecords(native, 'type', 'approval/asked').session_id = 'other-session';
  }],
  ['decision session differs', (native) => {
    forceEvidenceRecords(native, 'type', 'approval/decided').session_id = 'other-session';
  }],
  ['consumption session differs', (_native, probe) => {
    forceEvidenceRecords(probe, 'event', 'PROBE_APPROVAL_CONSUMED').session_id = 'other-session';
  }],
  ['approval ID reused', (native) => {
    const asked = structuredClone(forceEvidenceRecords(native, 'type', 'approval/asked'));
    assert.ok(isRecord(asked.data));
    asked.data.callId = 'other-call';
    native.push(asked);
  }],
  ['decision reused', (native) => {
    native.push(structuredClone(forceEvidenceRecords(native, 'type', 'approval/decided')));
  }],
  ['consumption duplicated', (_native, probe) => {
    probe.push(structuredClone(forceEvidenceRecords(probe, 'event', 'PROBE_APPROVAL_CONSUMED')));
  }],
  ['execution reuses approval and consumption', (_native, probe) => {
    probe.push(structuredClone(forceEvidenceRecords(probe, 'event', 'PROBE_ACTION_EXECUTED')));
  }],
  ['decision follows success result', (native) => {
    const decision = forceEvidenceRecords(native, 'type', 'approval/decided');
    native.splice(native.indexOf(decision), 1);
    native.push(decision);
  }],
  ['consumption follows execution', (_native, probe) => {
    const consumed = forceEvidenceRecords(probe, 'event', 'PROBE_APPROVAL_CONSUMED');
    probe.splice(probe.indexOf(consumed), 1);
    probe.push(consumed);
  }],
  ['native call duplicated', (native) => {
    native.push(structuredClone(forceEvidenceRecords(native, 'type', 'tool/call')));
  }],
  ['native result duplicated', (native) => {
    native.push(structuredClone(forceEvidenceRecords(native, 'type', 'tool/result')));
  }],
];

for (const [label, mutate] of forceEvidenceMutations) {
  test('force acceptance rejects mismatched authorization evidence: ' + label, () => {
    const original = requireCase(defaultResult, 'E');
    assert.deepEqual(evaluateCaseAcceptance(original, { id: 'E' }).issues, []);
    const native: unknown[] = structuredClone([...original.nativeEvents]);
    const probe: unknown[] = structuredClone([...original.probeEvents]);
    mutate(native, probe);
    const report = evaluateCaseAcceptance({ ...original, nativeEvents: native, probeEvents: probe }, { id: 'E' });
    assert.ok(report.issues.some((issue) => issue.category === 'safety' && issue.code === 'force-authorization-binding'), JSON.stringify(report.issues));
  });
}
