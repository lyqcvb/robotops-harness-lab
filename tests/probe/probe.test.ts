import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { evaluateLiveAcceptance } from '../../src/eval/probe-acceptance.js';
import {
  readInstalledVersions,
  readLockfileDigest,
  redactValue,
  safeError,
  writeEvidenceBundle,
} from '../../src/trace/probe-evidence.js';
import type { LiveSmokeResult } from '../../src/contracts/probe.js';
import type { ProbeSummary } from '../../src/contracts/probe-evidence.js';

const projectRoot = process.cwd();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

  assert.ok(Array.isArray(summary.gates));
  assert.deepEqual(
    summary.gates.map((gate) => (isRecord(gate) ? [gate.name, gate.status] : null)),
    [['static-versions', 'PASS'], ['live-gate', 'BLOCKED']],
  );
  assert.deepEqual(summary.cases, []);

  // No model was called, so the event files exist but carry no rows.
  for (const fileName of ['native-events.jsonl', 'probe-events.jsonl']) {
    const rows = await readJsonLines(path.join(evidenceDir, fileName));
    assert.equal(rows.length, 0, `${fileName} must not contain rows without a live run`);
    const batchSequences = rows.map((row) => row.batch_sequence);
    assert.deepEqual(
      batchSequences,
      rows.map((_, index) => index + 1),
      `${fileName} batch_sequence must be globally continuous`,
    );
    assert.equal(new Set(batchSequences).size, rows.length, `${fileName} batch_sequence must not repeat`);
  }
});

test('live acceptance fails closed when no real get_robot_status call was observed', () => {
  const result: LiveSmokeResult = {
    id: 'LIVE',
    status: 'PASS',
    modelRequests: 1,
    toolRequests: 0,
    actionExecutions: 0,
    approvalAsked: 0,
    approvalAllowedOnce: 0,
    executionsByName: {},
    sessionId: 'stage0-session',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    toolNames: ['get_robot_status'],
    persistedEventCount: 0,
    nativeEvents: [],
    probeEvents: [],
    notes: [],
    error: null,
    liveCalledGetRobotStatus: false,
    liveToolResultReadable: false,
  };
  const report = evaluateLiveAcceptance(result);
  assert.equal(report.passed, false);
  const codes = report.issues.map((issue) => issue.code);
  for (const code of ['live-call-not-observed', 'live-result-not-readable', 'live-execution-not-observed']) {
    assert.ok(codes.includes(code), code);
  }
  assert.ok(report.issues.every((issue) => issue.category === 'live'));
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
    harnessVersion: 'test', installedVersions: {}, lockfileSha256: '', mode: 'live',
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
