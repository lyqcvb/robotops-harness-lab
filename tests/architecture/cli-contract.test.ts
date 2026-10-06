import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: Error | null;
}

interface RunNodeOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}


function childDescription(result: ChildResult): string {
  return `code=${String(result.code)} signal=${String(result.signal)} timedOut=${result.timedOut} error=${result.error?.message ?? 'none'} stdout=${result.stdout} stderr=${result.stderr}`;
}

function withEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

function runNode(
  args: readonly string[],
  options: RunNodeOptions,
): Promise<ChildResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const child = spawn(process.execPath, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      error: Error | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({ code, signal, stdout, stderr, timedOut, error });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error: Error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal, null));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      forceTimer = setTimeout(() => finish(null, null, new Error('child did not close after timeout')), 1_000);
    }, timeoutMs);
  });
}

async function createMetadataProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'robotops-cli-test-'));
  try {
    const packageLockPath = path.join(projectRoot, 'package-lock.json');
    await copyFile(path.join(repositoryRoot, 'package-lock.json'), packageLockPath);
    await copyFile(path.join(repositoryRoot, 'package.json'), path.join(projectRoot, 'package.json'));
    const lock = JSON.parse(await readFile(packageLockPath, 'utf8')) as {
      readonly packages?: Record<string, { readonly version?: unknown }>;
    };
    for (const packageName of checkedDependencies) {
      const version = lock.packages?.[`node_modules/${packageName}`]?.version;
      if (typeof version !== 'string') {
        throw new Error(`package-lock.json has no version for ${packageName}`);
      }
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

async function snapshotDirectory(
  directory: string,
): Promise<readonly string[] | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const result: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      result.push(`${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`);
      if (entry.isDirectory()) {
        const descendants = await snapshotDirectory(path.join(directory, entry.name));
        if (descendants !== null) {
          result.push(...descendants.map((item) => `${entry.name}/${item}`));
        }
      }
    }
    return result.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function runDirectories(projectRoot: string): Promise<readonly string[]> {
  return readdir(path.join(projectRoot, 'results'), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    )
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
}

test('importing the real app module has no side effects', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'robotops-import-test-'));
  try {
    await mkdir(path.join(projectRoot, 'results'), { recursive: true });
    await mkdir(path.join(projectRoot, '.stage0'), { recursive: true });
    await writeFile(path.join(projectRoot, 'results', 'keep.txt'), 'keep\n', 'utf8');
    await writeFile(path.join(projectRoot, '.stage0', 'keep.txt'), 'keep\n', 'utf8');

    const beforeResults = await snapshotDirectory(path.join(projectRoot, 'results'));
    const beforePersistence = await snapshotDirectory(path.join(projectRoot, '.stage0'));
    const appModuleUrl = pathToFileURL(
      path.join(repositoryRoot, 'build', 'src', 'app', 'business.js'),
    ).href;
    const importScript = `await import(${JSON.stringify(appModuleUrl)});`;
    const result = await runNode(
      ['--input-type=module', '--eval', importScript],
      {
        cwd: projectRoot,
        env: withEnvironment({ DEEPSEEK_API_KEY: '' }),
        timeoutMs: 20_000,
      },
    );

    assert.equal(result.timedOut, false, childDescription(result));
    assert.equal(result.error, null, childDescription(result));
    assert.equal(result.code, 0, childDescription(result));
    assert.equal(result.stdout, '', childDescription(result));
    assert.equal(result.stderr, '', childDescription(result));
    assert.deepEqual(
      await snapshotDirectory(path.join(projectRoot, 'results')),
      beforeResults,
      'importing the app module must not alter results',
    );
    assert.deepEqual(
      await snapshotDirectory(path.join(projectRoot, '.stage0')),
      beforePersistence,
      'importing the app module must not alter persistence state',
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('real CLI rejects unknown options and missing option values with exit code 2', async () => {
  const cliPath = path.join(repositoryRoot, 'build', 'scripts', 'business.js');
  const env = withEnvironment({ DEEPSEEK_API_KEY: '' });

  for (const argv of [['e2e', '--unknown'], ['e2e', '--scenario']]) {
    const result = await runNode([cliPath, ...argv], {
      cwd: repositoryRoot,
      env,
      timeoutMs: 15_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, childDescription(result));
    assert.equal(result.error, null, childDescription(result));
    assert.equal(result.code, 2, childDescription(result));
    assert.match(output, /usage|unknown|missing|required/i, childDescription(result));
    assert.doesNotMatch(output, /\bPASS\b/i, childDescription(result));
  }
});

test('missing-key e2e exits BLOCKED with a complete run bundle and no provider attempt', async () => {
  const projectRoot = await createMetadataProjectRoot();
  try {
    const cliPath = path.join(repositoryRoot, 'build', 'scripts', 'business.js');
    const result = await runNode([cliPath, 'e2e'], {
      cwd: projectRoot,
      env: withEnvironment({ DEEPSEEK_API_KEY: '' }),
      timeoutMs: 20_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, childDescription(result));
    assert.equal(result.error, null, childDescription(result));
    assert.equal(result.code, 2, childDescription(result));
    assert.match(output, /BLOCKED/, childDescription(result));
    assert.doesNotMatch(output, /\bPASS\b/i, childDescription(result));

    const directories = await runDirectories(projectRoot);
    assert.equal(directories.length, 1, `expected one run directory, got ${directories.join(', ')}`);
    const directory = path.join(projectRoot, 'results', directories[0]!);
    const bundle = await readRunBundle(directory);

    assert.equal(bundle.manifest.mode, 'live');
    assert.equal(bundle.manifest.scenario_id, 'navigation_restart_success');
    assert.equal(bundle.manifest.config, 'full');
    assert.equal(bundle.manifest.approval_source, 'scripted');
    assert.equal(bundle.metrics.status, 'BLOCKED');
    assert.equal(bundle.metrics.model_requests, 0);
    assert.equal(bundle.metrics.task_success, false);
    assert.equal(bundle.nativeEvents.length, 0, 'missing-key path must not create a provider session');
    assert.equal(bundle.events[0]?.type, 'simulator_initialized');
    assert.equal(bundle.events.at(-1)?.type, 'run_finished');
    const terminal = bundle.events.at(-1);
    assert.ok(terminal !== undefined);
    assert.equal(terminal.data.runtime_status, 'BLOCKED');
    assert.equal(
      bundle.events.some(
        (event) => event.type === 'model_request' && event.data.dispatched === true,
      ),
      false,
      'missing-key path must not dispatch a provider request',
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});


test('demo source and CLI contract pin the core manual scenario and reject scripted approval', async () => {
  const source = await readFile(path.join(repositoryRoot, 'src', 'app', 'business-cli.ts'), 'utf8');
  const demoStart = source.indexOf('async function runDemo');
  const demoEnd = source.indexOf('\nexport async function dispatch', demoStart);
  assert.ok(demoStart >= 0 && demoEnd > demoStart, 'runDemo must be present');
  const demoSource = source.slice(demoStart, demoEnd);

  assert.match(demoSource, /scenarioId:\s*'navigation_restart_fail_then_reboot'/);
  assert.match(demoSource, /config:\s*'full'/);
  assert.match(demoSource, /mode:\s*'live'/);
  assert.match(demoSource, /approvalMode:\s*'manual'/);
  assert.doesNotMatch(demoSource, /navigation_restart_success/);
  assert.doesNotMatch(demoSource, /approvalMode:\s*'scripted'/);
  assert.match(
    source,
    /const DEFAULT_E2E[\s\S]*?scenarioId: 'navigation_restart_success'[\s\S]*?config: 'full'[\s\S]*?approvalMode: 'scripted'/,
    'test:e2e default must remain navigation_restart_success/full/scripted',
  );

  const cliPath = path.join(repositoryRoot, 'build', 'scripts', 'business.js');
  const result = await runNode([cliPath, 'demo', '--approval', 'scripted'], {
    cwd: repositoryRoot,
    env: withEnvironment({ DEEPSEEK_API_KEY: '' }),
    timeoutMs: 15_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.timedOut, false, childDescription(result));
  assert.equal(result.error, null, childDescription(result));
  assert.equal(result.code, 2, childDescription(result));
  assert.match(output, /manual|scripted/i, childDescription(result));
  assert.doesNotMatch(output, /\bPASS\b/i, childDescription(result));
});