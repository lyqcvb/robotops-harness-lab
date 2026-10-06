import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { main } from '../../src/app/business.js';
import { SCENARIO_IDS } from '../../src/contracts/run.js';
import type { BusinessMetrics, RecoveryMode, RunManifest, ScenarioId } from '../../src/contracts/run.js';
import type { ExecutionContext, ToolName, ToolResult } from '../../src/contracts/business.js';
import { recomputeRun } from '../../src/eval/business-report.js';
import { getBusinessScenario } from '../../src/harness/business-scenarios.js';
import { DEFAULT_BUDGETS, HARNESS_VERSION } from '../../src/contracts/policy.js';
import { digest, readRunBundle } from '../../src/trace/run-evidence.js';
import { collectRunProvenance } from '../../src/trace/run-provenance.js';
import { BusinessServices } from '../../src/services/business-services.js';

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

interface RunBusinessOptions {
  readonly projectRoot: string;
  readonly scenarioId: ScenarioId;
  readonly config: RecoveryMode;
  readonly mode: 'offline' | 'live';
  readonly approvalMode: 'scripted' | 'manual' | 'none';
  readonly batchId?: string;
  readonly repeat?: number;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly manualDecide?: ApprovalDecide;
}

interface BusinessRunResult {
  readonly directory: string;
  readonly manifest: RunManifest;
  readonly metrics: BusinessMetrics;
}

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

async function runBusiness(options: RunBusinessOptions): Promise<BusinessRunResult> {
  const execute = await loadExport<(
    input: RunBusinessOptions,
  ) => Promise<BusinessRunResult>>('../../src/app/business.js', 'runBusiness');
  return execute(options);
}

async function expectedInstalledVersions(projectRoot: string): Promise<Record<string, string>> {
  const lock = JSON.parse(
    await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'),
  ) as {
    readonly packages?: Record<string, { readonly version?: unknown }>;
  };
  return Object.fromEntries(
    checkedDependencies.map((packageName) => {
      const version = lock.packages?.[`node_modules/${packageName}`]?.version;
      if (typeof version !== 'string') {
        throw new Error(`${packageName} must have a lock version`);
      }
      return [packageName, version];
    }),
  );
}

async function assertReadableEvidenceFiles(directory: string): Promise<void> {
  const expectedFiles = [
    'manifest.json',
    'business-events.jsonl',
    'native-events.jsonl',
    'metrics.json',
  ];
  for (const fileName of expectedFiles) {
    const contents = await readFile(path.join(directory, fileName), 'utf8');
    assert.ok(
      contents.length > 0,
      `${fileName} must be readable and non-empty in ${directory}`,
    );
  }
}

function resultDiagnostic(result: BusinessRunResult): string {
  return `run=${result.directory} status=${result.metrics.status} integrity=${JSON.stringify(result.metrics.integrity_errors)}`;
}

test('offline run writes a complete bundle, recomputes exactly, and creates unique directories', async () => {
  const projectRoot = await createMetadataProjectRoot();
  try {
    const scenarioId: ScenarioId = 'navigation_restart_fail_then_reboot';
    const config: RecoveryMode = 'full';
    const options: RunBusinessOptions = {
      projectRoot,
      scenarioId,
      config,
      mode: 'offline',
      approvalMode: 'scripted',
      batchId: 'app-offline-bundle-test',
      repeat: 1,
    };

    const first = await runBusiness(options);
    assert.equal(first.metrics.status, 'PASS', resultDiagnostic(first));
    assert.equal(first.manifest.mode, 'offline');
    assert.equal(first.manifest.scenario_id, scenarioId);
    assert.equal(first.manifest.config, config);
    assert.equal(first.manifest.model, 'scripted-business-v1');
    assert.equal(first.manifest.approval_source, 'scripted');
    assert.equal(first.manifest.schema_version, 2);
    assert.equal(first.manifest.batch_id, 'app-offline-bundle-test');
    assert.equal(first.manifest.repeat, 1);
    assert.equal(first.manifest.run_id, path.basename(first.directory));
    assert.equal(path.dirname(first.directory), path.join(projectRoot, 'results'));
    assert.ok(Number.isFinite(Date.parse(first.manifest.created_at)));

    const scenario = getBusinessScenario(scenarioId, config);
    const expectedFixtureDigest = digest({
      fixture: scenario.fixture,
      failures: scenario.failures,
    });
    assert.equal(first.manifest.fixture_sha256, expectedFixtureDigest);
    assert.notEqual(first.manifest.fixture_sha256, digest(scenario.fixture));
    assert.equal(first.manifest.prompt_sha256, digest(scenario.prompt));
    const expectedConfigDigest = digest({
      mode: 'offline',
      recovery_mode: config,
      approval_source: 'scripted',
      model: 'scripted-business-v1',
      budgets: {
        model_requests: DEFAULT_BUDGETS.modelRequests,
        tool_calls: DEFAULT_BUDGETS.toolCalls,
        active_ms: DEFAULT_BUDGETS.activeMs,
        approval_ms: DEFAULT_BUDGETS.approvalMs,
      },
    });
    assert.equal(first.manifest.config_sha256, expectedConfigDigest);
    assert.notEqual(first.manifest.config_sha256, digest(config));
    assert.equal(first.manifest.harness_version, HARNESS_VERSION);
    assert.ok(first.manifest.harness_version.length > 0);
    if (first.manifest.schema_version !== 2) assert.fail('new runs must use manifest schema_version 2');
    const provenance = first.manifest.provenance;
    assert.deepEqual(provenance, await collectRunProvenance());
    assert.equal(provenance.schema_version, 1);
    assert.equal(provenance.basis, 'compiled-javascript');
    assert.equal(provenance.evaluator.version, 'business-evaluator-v2');
    assert.match(provenance.code.sha256, /^[a-f0-9]{64}$/);
    assert.match(provenance.evaluator.sha256, /^[a-f0-9]{64}$/);
    assert.ok(provenance.code.files.some((entry) => entry.path === 'app/business.js'));
    assert.ok(provenance.code.files.some((entry) => entry.path === 'eval/business-acceptance.js'));
    assert.ok(provenance.code.files.some((entry) => entry.path === 'contracts/run.js'));
    assert.ok(provenance.code.files.some((entry) => entry.path === 'trace/run-evidence.js'));

    const lockBytes = await readFile(path.join(projectRoot, 'package-lock.json'));
    assert.equal(
      first.manifest.lockfile_sha256,
      `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`,
    );
    assert.deepEqual(
      first.manifest.installed_versions,
      await expectedInstalledVersions(projectRoot),
    );

    await assertReadableEvidenceFiles(first.directory);
    const bundle = await readRunBundle(first.directory);
    assert.deepEqual(bundle.manifest, first.manifest);
    assert.deepEqual(bundle.metrics, first.metrics);
    assert.ok(bundle.events.length > 0, 'offline run must persist business events');
    assert.equal(bundle.events[0]?.type, 'simulator_initialized');
    assert.equal(bundle.events.at(-1)?.type, 'run_finished');
    assert.ok(bundle.nativeEvents.length > 0, 'offline scripted runtime must persist native events');
    assert.equal(first.metrics.action_executions.restart_navigation, 2);
    assert.equal(first.metrics.action_executions.force_reboot, 1);
    assert.equal(first.metrics.action_executions.resume_task, 1);
    assert.equal(first.metrics.task_success, true);

    const recomputed = await recomputeRun(first.directory);
    assert.deepEqual(recomputed, first.metrics, 'recomputeRun must match the recorded metrics');

    const recomputeOutput: string[] = [];
    const recomputeCode = await main(['recompute', '--run', first.directory], {
      cwd: projectRoot,
      env: { DEEPSEEK_API_KEY: '' },
      stdout: (line) => { recomputeOutput.push(line); },
      stderr: (line) => { recomputeOutput.push(line); },
    });
    assert.equal(recomputeCode, 0, recomputeOutput.join('\n'));
    const recomputeSummary = JSON.parse(recomputeOutput.at(-1)!) as {
      readonly runs: readonly {
        readonly status: string;
        readonly evaluator_compatibility: { readonly status: string } | null;
      }[];
    };
    assert.equal(recomputeSummary.runs[0]?.status, 'MATCH');
    assert.equal(recomputeSummary.runs[0]?.evaluator_compatibility?.status, 'MATCH');

    const second = await runBusiness(options);
    assert.notEqual(second.directory, first.directory);
    assert.notEqual(second.manifest.run_id, first.manifest.run_id);
    assert.equal(second.manifest.run_id, path.basename(second.directory));
    const resultDirectories = (await readdir(path.join(projectRoot, 'results'), {
      withFileTypes: true,
    }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(
      resultDirectories,
      [path.basename(first.directory), path.basename(second.directory)].sort(),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('approvalMode none never auto-approves force_reboot', async () => {
  const projectRoot = await createMetadataProjectRoot();
  try {
    const result = await runBusiness({
      projectRoot,
      scenarioId: 'navigation_restart_fail_then_reboot',
      config: 'full',
      mode: 'offline',
      approvalMode: 'none',
      batchId: 'app-approval-none-test',
      repeat: 1,
    });

    assert.notEqual(result.metrics.status, 'PASS', resultDiagnostic(result));
    assert.equal(result.metrics.action_executions.force_reboot, 0);
    assert.deepEqual(result.metrics.approval_sources, []);

    const bundle = await readRunBundle(result.directory);
    const decisions = bundle.events.filter((event) => event.type === 'approval_decided');
    assert.equal(decisions.length, 0, 'approvalMode none must not record an approval decision');
    assert.ok(
      bundle.events.some((event) => event.type === 'approval_unavailable' || event.type === 'approval_invalid'),
      'approvalMode none must record that no approval channel was available',
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('approvalMode scripted uses only the explicit scripted decision', async () => {
  const projectRoot = await createMetadataProjectRoot();
  let manualCalls = 0;
  const manualDecide: ApprovalDecide = async () => {
    manualCalls += 1;
    return 'cancelled';
  };

  try {
    const result = await runBusiness({
      projectRoot,
      scenarioId: 'navigation_restart_fail_then_reboot',
      config: 'full',
      mode: 'offline',
      approvalMode: 'scripted',
      manualDecide,
      batchId: 'app-approval-scripted-test',
      repeat: 1,
    });

    assert.equal(result.metrics.status, 'PASS', resultDiagnostic(result));
    assert.equal(result.metrics.action_executions.force_reboot, 1);
    assert.deepEqual(result.metrics.approval_sources, ['scripted']);
    assert.equal(manualCalls, 0, 'scripted mode must not call a manual decision provider');

    const bundle = await readRunBundle(result.directory);
    const decisions = bundle.events.filter((event) => event.type === 'approval_decided');
    const consumed = bundle.events.filter((event) => event.type === 'approval_consumed');
    assert.ok(decisions.length > 0, 'scripted run must record an approval decision');
    assert.deepEqual(
      decisions.map((event) => event.data.source),
      decisions.map(() => 'scripted'),
    );
    assert.ok(consumed.length > 0, 'scripted run must consume the approved force_reboot grant');
    assert.deepEqual(
      consumed.map((event) => event.data.source),
      consumed.map(() => 'scripted'),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('soft stop without a model-created ticket stays failed and skips host cleanup', async () => {
  const projectRoot = await createMetadataProjectRoot();
  const originalInvoke = BusinessServices.prototype.invoke;
  BusinessServices.prototype.invoke = function (
    this: BusinessServices,
    name: ToolName,
    args: Record<string, string>,
    context: ExecutionContext,
  ): ToolResult {
    if (name === 'create_maintenance_ticket') {
      return {
        status: 'FATAL_FAILURE',
        error_code: 'TEST_TICKET_UNAVAILABLE',
        reason: 'test: model did not create a maintenance ticket',
        data: null,
      };
    }
    return originalInvoke.call(this, name, args, context);
  };

  try {
    const result = await runBusiness({
      projectRoot,
      scenarioId: 'sop_missing',
      config: 'full',
      mode: 'offline',
      approvalMode: 'none',
      batchId: 'app-soft-stop-no-ticket-test',
      repeat: 1,
    });
    assert.equal(result.metrics.status, 'FAIL', resultDiagnostic(result));
    assert.ok(
      result.metrics.integrity_errors.length > 0,
      'missing model-created ticket must be exposed by metrics',
    );

    const bundle = await readRunBundle(result.directory);
    const forbiddenEvents = new Set(['host_cleanup', 'ticket_created', 'ticket_reused']);
    assert.deepEqual(
      bundle.events
        .filter((event) => forbiddenEvents.has(event.type))
        .map((event) => event.type),
      [],
      'soft stop must not fabricate host cleanup or maintenance tickets',
    );
  } finally {
    BusinessServices.prototype.invoke = originalInvoke;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('manual approval rejects automatic input when the injected reader is non-TTY', { timeout: 5_000 }, async () => {
  const projectRoot = await createMetadataProjectRoot();
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

    const result = await runBusiness({
      projectRoot,
      scenarioId: 'navigation_restart_fail_then_reboot',
      config: 'full',
      mode: 'offline',
      approvalMode: 'manual',
      manualDecide: decide,
      batchId: 'app-manual-nontty-test',
      repeat: 1,
    });
    assert.notEqual(result.metrics.status, 'PASS', resultDiagnostic(result));
    assert.equal(result.metrics.action_executions.force_reboot, 0);

    const bundle = await readRunBundle(result.directory);
    assert.equal(
      bundle.events.some(
        (event) => event.type === 'approval_decided' && event.data.decision === 'approved',
      ),
      false,
      'non-TTY manual approval must never become an approved decision',
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    input.destroy();
    output.end();
  }
});



function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), label);
  return value.map((item: unknown) => {
    assert.ok(isRecord(item), label);
    return item;
  });
}

function assertEvalCounts(
  record: Record<string, unknown>,
  metrics: readonly BusinessMetrics[],
): void {
  assert.equal(record.pass, metrics.filter((item) => item.status === 'PASS').length);
  assert.equal(record.fail, metrics.filter((item) => item.status === 'FAIL').length);
  assert.equal(record.blocked, metrics.filter((item) => item.status === 'BLOCKED').length);
  assert.equal(record.task_success, metrics.filter((item) => item.task_success).length);
  assert.equal(
    record.unsafe_action_count,
    metrics.reduce((total, item) => total + item.unsafe_action_count, 0),
  );
}

// Exercise the real dispatcher, native offline runtime and on-disk evidence;
// neither the plan nor execution is mocked.
test('offline eval executes five scenarios by two configs by three scripted repeats', { timeout: 60_000 }, async () => {
  const projectRoot = await createMetadataProjectRoot();
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const code = await main(['eval', '--offline'], {
      cwd: projectRoot,
      env: { DEEPSEEK_API_KEY: '' },
      stdout: (line) => { stdout.push(line); },
      stderr: (line) => { stderr.push(line); },
    });
    assert.equal(code, 0, stdout.concat(stderr).join('\n'));
    assert.deepEqual(stderr, []);
    assert.equal(stdout.length, 31, '30 run reports and one batch summary are required');
    assert.doesNotMatch(stdout.join('\n'), /approval>|real interactive|Type exactly/i);

    const resultsRoot = path.join(projectRoot, 'results');
    const directories = (await readdir(resultsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'batches')
      .map((entry) => path.join(resultsRoot, entry.name));
    assert.equal(directories.length, 30);
    assert.equal(new Set(directories).size, 30);
    const batchIds = await readdir(path.join(resultsRoot, 'batches'));
    assert.equal(batchIds.length, 1, 'all runs must belong to exactly one batch');
    const batchId = batchIds[0]!;
    const summary: unknown = JSON.parse(await readFile(
      path.join(resultsRoot, 'batches', batchId, 'summary.json'), 'utf8',
    ));
    assert.ok(isRecord(summary));
    assert.deepEqual(JSON.parse(stdout.at(-1)!), summary);
    assert.equal(summary.batch_id, batchId);
    assert.equal(summary.command, 'eval');
    assert.equal(summary.mode, 'offline');
    assert.equal(summary.planned, 30);
    assert.equal(summary.expected, 30);
    assert.equal(summary.actual, 30);
    assert.equal(summary.missing, 0);
    assert.equal(summary.complete, true);
    assert.equal(summary.pass, 30);
    assert.equal(summary.fail, 0);
    assert.equal(summary.blocked, 0);
    assert.equal(summary.unsafe_action_count, 0);

    const plan = recordArray(summary.plan, 'batch plan');
    const runs = recordArray(summary.runs, 'batch runs');
    const groups = recordArray(summary.groups, 'batch groups');
    const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
    const expectedPlan = SCENARIO_IDS.flatMap((scenarioId) => configs.flatMap((config) =>
      [1, 2, 3].map((repeat) => ({
        scenario_id: scenarioId,
        config,
        approval_mode: 'scripted',
        approval_source: 'scripted',
        repeat,
      })),
    ));
    assert.equal(SCENARIO_IDS.length, 5);
    assert.deepEqual(plan, expectedPlan);
    assert.equal(runs.length, 30);
    assert.equal(groups.length, 10);
    assert.equal(new Set(runs.map((run) => run.run_id)).size, 30);
    assert.deepEqual(runs.map((run) => run.directory).sort(), [...directories].sort());
    assert.deepEqual(
      runs.map(({ scenario_id, config, repeat, approval_mode, approval_source }) =>
        ({ scenario_id, config, repeat, approval_mode, approval_source })),
      expectedPlan,
    );

    const bundles: Awaited<ReturnType<typeof readRunBundle>>[] = [];
    const sessionIds = new Set<string>();
    for (const run of runs) {
      assert.equal(typeof run.directory, 'string');
      assert.equal(run.error, null);
      const bundle = await readRunBundle(run.directory as string);
      bundles.push(bundle);
      const { manifest, metrics, events, nativeEvents } = bundle;
      assert.equal(manifest.run_id, run.run_id);
      assert.equal(manifest.scenario_id, run.scenario_id);
      assert.equal(manifest.config, run.config);
      assert.equal(manifest.repeat, run.repeat);
      assert.equal(manifest.batch_id, batchId);
      assert.equal(manifest.mode, 'offline');
      assert.equal(manifest.model, 'scripted-business-v1');
      assert.equal(manifest.approval_source, 'scripted');
      assert.equal(metrics.status, 'PASS', JSON.stringify(metrics));
      assert.deepEqual(metrics, run.metrics);
      assert.ok(metrics.approval_sources.every((source) => source === 'scripted'));
      const ready = events.find((event) => event.type === 'runtime_ready');
      assert.ok(ready);
      assert.equal(ready.data.approval_source, 'scripted', 'no manual approval callback may be selected');
      assert.equal(ready.data.mode, 'offline');
      assert.equal(ready.data.provider, 'business-scripted');
      const sessionId = ready.session_id;
      assert.ok(typeof sessionId === 'string' && sessionId.length > 0);
      assert.ok(!sessionIds.has(sessionId), 'every run must have a distinct native session');
      sessionIds.add(sessionId);
      assert.ok(events.every((event) => event.session_id === sessionId));
      const native = recordArray(nativeEvents, 'native session events');
      assert.ok(native.length > 0);
      assert.ok(native.every((event) => event.session_id === sessionId && event.run_id === manifest.run_id));
      assert.ok(native.some((event) => event.type === 'tool/call'));
      for (const pending of events.filter((event) => event.type === 'approval_pending')) {
        const decision = events.find((event) =>
          event.type === 'approval_decided' && event.call_id === pending.call_id);
        assert.ok(decision, 'every approval request must use the scripted decision channel');
        assert.equal(decision.data.source, 'scripted');
      }
      const persisted = events.find((event) => event.type === 'session_persisted');
      assert.ok(persisted);
      assert.equal(persisted.data.session_id, sessionId);
      assert.equal(persisted.data.handle_access, 'read');
      assert.equal(persisted.data.matched_snapshot, true);
      const persistenceRoot = path.join(projectRoot, '.stage0', 'business', manifest.run_id);
      const nativeFiles = (await readdir(persistenceRoot, { recursive: true }))
        .filter((entry) => path.basename(entry) === 'session.v3.jsonl');
      assert.equal(nativeFiles.length, 1, 'a real native session file must have been persisted');
      const durable = recordArray(
        (await readFile(path.join(persistenceRoot, nativeFiles[0]!), 'utf8'))
          .trim().split(/\r?\n/).map((line) => JSON.parse(line) as unknown),
        'durable session file',
      );
      assert.equal(durable[0]?.type, 'session');
      assert.equal(durable[0]?.id, sessionId);
      assert.ok(durable.length > 1);
      assert.equal(persisted.data.event_count, durable.length - 1);
    }
    assert.equal(sessionIds.size, 30);
    assertEvalCounts(summary, bundles.map((bundle) => bundle.metrics));
    assert.equal(summary.task_success, 15);
    assert.equal(new Set(groups.map((group) => JSON.stringify([group.scenario_id, group.config]))).size, 10);
    for (const scenarioId of SCENARIO_IDS) {
      for (const config of configs) {
        const group = groups.find((item) => item.scenario_id === scenarioId && item.config === config);
        assert.ok(group);
        assert.equal(group.approval_mode, 'scripted');
        assert.equal(group.approval_source, 'scripted');
        assert.equal(group.planned, 3);
        assert.equal(group.actual, 3);
        assert.equal(Object.hasOwn(group, 'repeat'), false, 'group must aggregate all three repeats');
        const matches = bundles.filter((bundle) =>
          bundle.manifest.scenario_id === scenarioId && bundle.manifest.config === config);
        assert.deepEqual(matches.map((bundle) => bundle.manifest.repeat).sort(), [1, 2, 3]);
        assert.deepEqual(group.run_ids, matches.map((bundle) => bundle.manifest.run_id));
        assert.deepEqual(group.statuses, ['PASS', 'PASS', 'PASS']);
        assert.equal(group.pass, 3);
        assert.equal(group.fail, 0);
        assert.equal(group.blocked, 0);
        assert.equal(group.unsafe_action_count, 0);
        assertEvalCounts(group, matches.map((bundle) => bundle.metrics));
      }
    }
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

for (const action of ['force_reboot', 'resume_task'] as const) {
  test(`cancelling after committed ${action} preserves state and creates one host ticket`, async () => {
    const projectRoot = await createMetadataProjectRoot();
    const controller = new AbortController();
    const originalInvoke = BusinessServices.prototype.invoke;
    const captured: { snapshot?: ReturnType<BusinessServices['snapshot']>; cancellations: number } = {
      cancellations: 0,
    };
    BusinessServices.prototype.invoke = function (
      this: BusinessServices,
      name: ToolName,
      args: Record<string, string>,
      context: ExecutionContext,
    ): ToolResult {
      const result = originalInvoke.call(this, name, args, context);
      if (name === action && result.status === 'SUCCESS') {
        captured.snapshot = this.snapshot();
        captured.cancellations += 1;
        controller.abort();
      }
      return result;
    };
    try {
      const result = await runBusiness({
        projectRoot,
        scenarioId: 'navigation_restart_fail_then_reboot',
        config: 'full',
        mode: 'offline',
        approvalMode: 'scripted',
        signal: controller.signal,
        batchId: `test-cancel-after-${action}`,
      });
      assert.equal(captured.cancellations, 1);
      assert.ok(captured.snapshot);
      assert.deepEqual(captured.snapshot.tickets, []);
      const bundle = await readRunBundle(result.directory);
      const terminal = bundle.events.at(-1);
      assert.equal(terminal?.type, 'run_finished');
      assert.equal(terminal?.data.runtime_status, 'CANCELLED');
      assert.ok(isRecord(terminal?.data.snapshot));
      const finalSnapshot = terminal.data.snapshot;
      assert.deepEqual(finalSnapshot.simulator, captured.snapshot.simulator, 'committed state must not be rolled back or advanced');
      assert.ok(Array.isArray(finalSnapshot.tickets));
      assert.equal(finalSnapshot.tickets.length, 1);
      const robot = captured.snapshot.simulator.robots.find((item) => item.robot_id === 'R-03');
      const task = captured.snapshot.simulator.tasks.find((item) => item.task_id === 'TASK-502');
      assert.equal(robot?.state, action === 'force_reboot' ? 'IDLE' : 'MOVING');
      assert.equal(robot?.error_code, null);
      assert.equal(task?.status, action === 'force_reboot' ? 'PAUSED' : 'RUNNING');
      assert.equal(result.metrics.action_executions.force_reboot, 1);
      assert.equal(result.metrics.action_executions.resume_task, action === 'force_reboot' ? 0 : 1);
      assert.equal(result.metrics.unsafe_action_count, 0);
      const created = bundle.events.filter((event) => event.type === 'ticket_created');
      const cleanup = bundle.events.filter((event) => event.type === 'host_cleanup');
      assert.equal(created.length, 1);
      assert.equal(cleanup.length, 1);
      assert.equal(cleanup[0]!.data.runtime_status, 'CANCELLED');
      assert.equal(cleanup[0]!.call_id, `host-cleanup-${result.manifest.run_id}`);
      assert.match(String(cleanup[0]!.data.reason), /^Host cleanup after runtime status CANCELLED/);
      assert.equal(created[0]!.call_id, cleanup[0]!.call_id);
      assert.equal(bundle.events.some((event) =>
        (event.type === 'tool_requested' || event.type === 'handler_started') &&
        event.call_id === cleanup[0]!.call_id), false, 'host cleanup is not a fabricated model tool call');
      const committed = bundle.events.find((event) =>
        event.type === 'action_finished' && event.data.action === action);
      assert.ok(committed);
      assert.deepEqual(bundle.events.filter((event) =>
        event.seq > committed.seq && event.type === 'action_started'), [], 'no new robot action may start after cancellation');
    } finally {
      BusinessServices.prototype.invoke = originalInvoke;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
}

for (const changedFile of [
  'invalid metrics.json',
  'missing metrics.json',
  'different metrics.json',
  'manifest.json',
  'business-events.jsonl',
  'native-events.jsonl',
] as const) {
  test(`recompute CLI preserves evidence and reports ${changedFile}`, async () => {
    const projectRoot = await createMetadataProjectRoot();
    try {
      const run = await runBusiness({
        projectRoot,
        scenarioId: 'happy_path',
        config: 'full',
        mode: 'offline',
        approvalMode: 'scripted',
      });
      const cacheChanged = changedFile.endsWith('metrics.json');
      const fileName = cacheChanged ? 'metrics.json' : changedFile;
      const targetPath = path.join(run.directory, fileName);
      const missing = changedFile === 'missing metrics.json';
      if (missing) await unlink(targetPath);
      else await writeFile(targetPath, changedFile === 'different metrics.json'
        ? JSON.stringify({ ...run.metrics, unsafe_action_count: 99 })
        : '{broken evidence', 'utf8');

      const fileNames = ['manifest.json', 'business-events.jsonl', 'native-events.jsonl', 'metrics.json'];
      const before = await Promise.all(fileNames.map(async (name) =>
        missing && name === 'metrics.json' ? null : readFile(path.join(run.directory, name), 'utf8')));
      const output: string[] = [];
      const code = await main(['recompute', '--run', run.directory], {
        cwd: projectRoot,
        env: { DEEPSEEK_API_KEY: '' },
        stdout: (line) => { output.push(line); },
        stderr: (line) => { output.push(line); },
      });
      const summary = JSON.parse(output.at(-1)!) as {
        readonly checked: number;
        readonly status: string;
        readonly differences: readonly { readonly directory: string; readonly reason: string }[];
        readonly runs: readonly {
          readonly status: string;
          readonly evaluator_compatibility: { readonly status: string } | null;
          readonly metrics: BusinessMetrics | null;
        }[];
      };
      assert.equal(code, 1, output.join('\n'));
      assert.equal(summary.status, 'FAIL');
      assert.equal(summary.checked, 1);
      assert.equal(summary.runs.length, 1);
      const result = summary.runs[0]!;
      assert.equal(result.status, changedFile === 'different metrics.json' ? 'DIFFERENT' : 'ERROR');
      assert.equal(summary.differences.length, 1);
      assert.equal(summary.differences[0]!.directory, run.directory);
      if (changedFile === 'different metrics.json') {
        assert.equal(summary.differences[0]!.reason, 'stored and recomputed metrics differ');
      } else {
        assert.ok(summary.differences[0]!.reason.includes(fileName));
        assert.match(summary.differences[0]!.reason, missing ? /ENOENT/ : /SyntaxError:.*invalid JSON/);
      }
      for (const [index, name] of fileNames.entries()) {
        const filePath = path.join(run.directory, name);
        if (missing && name === 'metrics.json') {
          await assert.rejects(() => readFile(filePath), { code: 'ENOENT' });
        } else {
          assert.equal(await readFile(filePath, 'utf8'), before[index], name);
        }
      }
      assert.deepEqual(result.metrics, cacheChanged ? run.metrics : null);
      if (cacheChanged) assert.equal(result.evaluator_compatibility?.status, 'MATCH');
      else assert.equal(result.evaluator_compatibility, null);
    } finally {
      assert.equal(path.dirname(path.resolve(projectRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(projectRoot).startsWith('robotops-app-test-'));
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
}
