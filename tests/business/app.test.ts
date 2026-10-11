import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { dispatch } from '../../src/app/business-cli.js';
import { runBusinessInternal } from '../../src/app/business-run.js';
import { DEFAULT_MODEL } from '../../src/contracts/policy.js';
import { readRunBundle } from '../../src/trace/run-evidence.js';

const repositoryRoot = process.cwd();

const checkedDependencies = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
] as const;

type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

interface ApprovalRequest {
  readonly run_id: string;
  readonly session_id: string;
  readonly call_id: string;
  readonly action: 'force_reboot';
  readonly args: Record<string, string>;
  readonly deadline_ms: number;
}

type ApprovalDecide = (
  request: ApprovalRequest,
  signal: AbortSignal,
) => Promise<ApprovalDecision>;

interface ManualApprovalOptions {
  readonly reader?: NodeJS.ReadableStream;
  readonly writer?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadExport<T>(relativePath: string, exportName: string): Promise<T> {
  const moduleUrl = new URL(relativePath, import.meta.url);
  const loaded: unknown = await import(moduleUrl.href);
  assert.ok(isRecord(loaded), `expected ${relativePath} to export an object`);
  const value = loaded[exportName];
  assert.equal(
    typeof value,
    'function',
    `expected ${relativePath} to export ${exportName}()`,
  );
  return value as T;
}

async function createMetadataProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'robotops-app-test-'));
  try {
    const packageLockPath = path.join(projectRoot, 'package-lock.json');
    await copyFile(path.join(repositoryRoot, 'package-lock.json'), packageLockPath);
    await copyFile(path.join(repositoryRoot, 'package.json'), path.join(projectRoot, 'package.json'));

    const lock = JSON.parse(await readFile(packageLockPath, 'utf8')) as {
      readonly packages?: Record<string, { readonly version?: unknown }>;
    };
    for (const packageName of checkedDependencies) {
      const version = lock.packages?.[`node_modules/${packageName}`]?.version;
      assert.equal(
        typeof version,
        'string',
        `package-lock.json must contain a real version for ${packageName}`,
      );
      const metadataDirectory = path.join(
        projectRoot,
        'node_modules',
        ...packageName.split('/'),
      );
      await mkdir(metadataDirectory, { recursive: true });
      await writeFile(
        path.join(metadataDirectory, 'package.json'),
        `${JSON.stringify({ name: packageName, version }, null, 2)}\n`,
        'utf8',
      );
    }
    return projectRoot;
  } catch (error) {
    await rm(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

test('a run without DEEPSEEK_API_KEY is blocked before any model call and has no offline fallback', async () => {
  const projectRoot = await createMetadataProjectRoot();
  try {
    const result = await runBusinessInternal(
      {
        projectRoot,
        scenarioId: 'navigation_restart_fail_then_reboot',
        config: 'full',
        approvalMode: 'scripted',
        batchId: 'app-no-key-test',
        repeat: 1,
      },
      {},
    );
    assert.equal(result.metrics.status, 'BLOCKED');
    assert.equal(result.metrics.scenario_pass, false);
    assert.equal(result.metrics.model_requests, 0);
    assert.deepEqual(result.metrics.action_executions, { restart_navigation: 0, force_reboot: 0, resume_task: 0 });
    assert.equal(result.manifest.mode, 'live');
    assert.equal(result.manifest.model, DEFAULT_MODEL);
    assert.match(result.manifest.run_id, /-live-/);

    const bundle = await readRunBundle(result.directory);
    assert.deepEqual(bundle.manifest, result.manifest);
    assert.deepEqual(bundle.nativeEvents, []);
    const blocked = bundle.events.find((event) => event.type === 'runtime_blocked');
    assert.ok(blocked, 'missing runtime_blocked event');
    assert.match(JSON.stringify(blocked.data), /DEEPSEEK_API_KEY/);
    assert.equal(bundle.events.some((event) => event.type === 'model_request'), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('manual approval rejects automatic input when the injected reader is non-TTY', { timeout: 5_000 }, async () => {
  const createManualApproval = await loadExport<(
    options?: ManualApprovalOptions,
  ) => ApprovalDecide>('../../src/app/manual-approval.js', 'createManualApproval');

  const fakeNow = 1_000;
  const input = Readable.from(['approve call-manual-1\n']);
  const outputChunks: string[] = [];
  const output = new Writable({
    write(chunk: string | Buffer, _encoding, callback) {
      outputChunks.push(String(chunk));
      callback();
    },
  });

  try {
    const decide = createManualApproval({
      reader: input,
      writer: output,
      isTTY: false,
      now: () => fakeNow,
      timeoutMs: 200,
    });
    const decision = await decide(
      {
        run_id: 'run-manual-test',
        session_id: 'session-manual-test',
        call_id: 'call-manual-1',
        action: 'force_reboot',
        args: { robot_id: 'R-03' },
        deadline_ms: 1_200,
      },
      new AbortController().signal,
    );

    assert.equal(decision, 'cancelled');
    assert.match(
      outputChunks.join(''),
      /non-tty|interactive tty|interactive terminal|真实交互终端/i,
      'non-TTY manual approval must explain that an interactive terminal is required',
    );
  } finally {
    input.destroy();
    output.end();
  }
});

test('an interrupted eval batch schedules no further runs and exits non-zero as incomplete', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'robotops-eval-interrupt-'));
  const interrupt = new AbortController();
  interrupt.abort();
  const stdout: string[] = [];
  try {
    const code = await dispatch(['eval', '--repeats', '1'], {
      cwd: projectRoot,
      env: {},
      signal: interrupt.signal,
      stdout: (line) => {
        stdout.push(line);
      },
      stderr: () => undefined,
    });
    assert.equal(code, 2);

    const summary = JSON.parse(stdout[stdout.length - 1] ?? '{}') as Record<string, unknown>;
    assert.equal(summary.actual, 0);
    assert.equal(summary.missing, summary.planned);
    assert.equal(summary.complete, false);
    const batchId = String(summary.batch_id);
    const persisted = JSON.parse(
      await readFile(path.join(projectRoot, 'results', 'batches', batchId, 'summary.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(persisted.complete, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
