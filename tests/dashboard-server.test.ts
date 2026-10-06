import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test, { type TestContext } from 'node:test';

import { parseDashboardPort } from '../src/app/dashboard.js';
import { createDashboardServer } from '../src/dashboard/server.js';

const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 20_000;

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface RequestOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Harness {
  readonly root: string;
  readonly server: Server;
  readonly port: number;
}

interface RunFiles {
  readonly manifest?: unknown | string;
  readonly metrics?: unknown | string;
  readonly events?: readonly unknown[] | string;
  readonly nativeEvents?: readonly unknown[] | string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeLines(values: readonly unknown[]): string {
  return values.length === 0 ? '' : `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function runManifest(id: string): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: id,
    created_at: '2026-09-28T00:00:00.000Z',
    scenario_id: 'happy_path',
    mode: 'offline',
    model: 'scripted-test',
    config: 'full',
    approval_source: 'none',
    batch_id: 'dashboard-test',
    repeat: 1,
    fixture_sha256: 'fixture',
    prompt_sha256: 'prompt',
    config_sha256: 'config',
    lockfile_sha256: 'lock',
    installed_versions: { test: '1.0.0' },
    harness_version: 'test',
  };
}

function runMetrics(): Record<string, unknown> {
  return {
    status: 'PASS',
    task_success: true,
    recovery_success: true,
    scenario_pass: true,
    unsafe_action_count: 0,
    tool_requests: 2,
    tool_executions: 2,
    model_requests: 1,
    failed_tools: 0,
    approval_sources: [],
    active_ms: 100,
    approval_wait_ms: 0,
    tokens: 'NOT_MEASURED',
    cost: 'NOT_MEASURED',
    integrity_errors: [],
  };
}

async function createHarness(t: TestContext, secret?: string): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'robotops-dashboard-'));
  const previousSecret = process.env.DEEPSEEK_API_KEY;
  let server: Server;
  try {
    if (secret === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = secret;
    server = createDashboardServer({ projectRoot: root });
  } finally {
    if (previousSecret === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousSecret;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    await rm(root, { recursive: true, force: true });
  });
  return { root, server, port };
}

async function request(port: number, route: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return await new Promise<HttpResponse>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: options.method ?? 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function responseText(response: HttpResponse): string {
  return response.body.toString('utf8');
}

function responseJson<T>(response: HttpResponse): T {
  assert.match(String(response.headers['content-type']), /^application\/json/);
  return JSON.parse(responseText(response)) as T;
}

async function writeRun(root: string, id: string, files: RunFiles = {}): Promise<string> {
  const directory = path.join(root, 'results', id);
  await mkdir(directory, { recursive: true });
  if (files.manifest !== undefined) {
    const contents = typeof files.manifest === 'string' ? files.manifest : serializeJson(files.manifest);
    await writeFile(path.join(directory, 'manifest.json'), contents, 'utf8');
  }
  if (files.metrics !== undefined) {
    const contents = typeof files.metrics === 'string' ? files.metrics : serializeJson(files.metrics);
    await writeFile(path.join(directory, 'metrics.json'), contents, 'utf8');
  }
  if (files.events !== undefined) {
    const contents = typeof files.events === 'string' ? files.events : serializeLines(files.events);
    await writeFile(path.join(directory, 'business-events.jsonl'), contents, 'utf8');
  }
  if (files.nativeEvents !== undefined) {
    const contents = typeof files.nativeEvents === 'string' ? files.nativeEvents : serializeLines(files.nativeEvents);
    await writeFile(path.join(directory, 'native-events.jsonl'), contents, 'utf8');
  }
  return directory;
}

test('dashboard CLI accepts only a valid --port value', () => {
  assert.equal(parseDashboardPort([]), 4317);
  assert.equal(parseDashboardPort(['--port', '1']), 1);
  assert.equal(parseDashboardPort(['--port=65535']), 65_535);
  assert.equal(parseDashboardPort(['--port', '0']), null);
  assert.equal(parseDashboardPort(['--port', '65536']), null);
  assert.equal(parseDashboardPort(['--port', '12.5']), null);
  assert.equal(parseDashboardPort(['--port', '1234', 'extra']), null);
  assert.equal(parseDashboardPort(['--host', '127.0.0.1']), null);
});

test('serves the fixed static whitelist with security headers', async (t) => {
  const harness = await createHarness(t);
  const publicRoot = path.join(harness.root, 'src', 'dashboard', 'public');
  await mkdir(publicRoot, { recursive: true });
  await writeFile(path.join(publicRoot, 'index.html'), '<!doctype html><title>Dashboard</title>\n', 'utf8');
  await writeFile(path.join(publicRoot, 'app.js'), 'console.log("dashboard");\n', 'utf8');
  await writeFile(path.join(publicRoot, 'grouping.js'), 'export const value = 1;\n', 'utf8');
  await writeFile(path.join(publicRoot, 'style.css'), 'body { color: black; }\n', 'utf8');

  const index = await request(harness.port, '/');
  assert.equal(index.statusCode, 200);
  assert.match(String(index.headers['content-type']), /^text\/html/);
  assert.match(responseText(index), /Dashboard/);
  assert.equal(index.headers['content-security-policy'], EXPECTED_CSP);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['cache-control'], 'no-store');

  const app = await request(harness.port, '/app.js');
  assert.equal(app.statusCode, 200);
  assert.match(String(app.headers['content-type']), /^text\/javascript/);
  const grouping = await request(harness.port, '/grouping.js');
  assert.equal(grouping.statusCode, 200);
  assert.match(String(grouping.headers['content-type']), /^text\/javascript/);
  const style = await request(harness.port, '/style.css');
  assert.equal(style.statusCode, 200);
  assert.match(String(style.headers['content-type']), /^text\/css/);

  const head = await request(harness.port, '/', { method: 'HEAD' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], index.headers['content-length']);

  for (const route of ['/src/dashboard/public/index.html', '/results/run-a/manifest.json', '/unknown']) {
    const missing = await request(harness.port, route);
    assert.equal(missing.statusCode, 404, route);
  }
});

test('lists runs newest first and returns detail evidence', async (t) => {
  const harness = await createHarness(t);
  const olderEvents = [
    { run_id: 'run-a', session_id: 's-a', seq: 1, type: 'model_request', data: { count: 1 } },
    { run_id: 'run-a', session_id: 's-a', seq: 2, type: 'run_finished', data: { runtime_status: 'COMPLETE' } },
  ];
  const newerEvents = [
    { run_id: 'run-z', session_id: 's-z', seq: 1, type: 'tool_requested', data: { tool_name: 'get_robot_status' } },
  ];
  const olderNative = [
    { run_id: 'run-a', type: 'tool/call', data: { callId: 'c-1', name: 'get_robot_status' } },
  ];
  const newerNative = [
    { run_id: 'run-z', type: 'tool/result', data: { callId: 'c-2', success: true } },
  ];
  await writeRun(harness.root, 'run-a', {
    manifest: runManifest('run-a'),
    metrics: runMetrics(),
    events: olderEvents,
    nativeEvents: olderNative,
  });
  await writeRun(harness.root, 'run-z', {
    manifest: runManifest('run-z'),
    metrics: runMetrics(),
    events: newerEvents,
    nativeEvents: newerNative,
  });
  await mkdir(path.join(harness.root, 'results', 'batches'), { recursive: true });
  await mkdir(path.join(harness.root, 'results', '.hidden'), { recursive: true });
  await mkdir(path.join(harness.root, 'results', 'bad.id'), { recursive: true });

  const listResponse = await request(harness.port, '/api/runs');
  assert.equal(listResponse.statusCode, 200);
  const list = responseJson<{
    readonly runs: readonly {
      readonly id: string;
      readonly manifest: Record<string, unknown> | null;
      readonly metrics: Record<string, unknown> | null;
      readonly issues: readonly string[];
    }[];
    readonly truncated: boolean;
  }>(listResponse);
  assert.deepEqual(list.runs.map((run) => run.id), ['run-z', 'run-a']);
  assert.equal(list.truncated, false);
  assert.equal(list.runs[0]?.manifest?.run_id, 'run-z');
  assert.equal(list.runs[0]?.metrics?.status, 'PASS');
  assert.deepEqual(list.runs[0]?.issues, []);

  const detailResponse = await request(harness.port, '/api/runs/run-a');
  assert.equal(detailResponse.statusCode, 200);
  const detail = responseJson<{
    readonly id: string;
    readonly manifest: Record<string, unknown> | null;
    readonly metrics: Record<string, unknown> | null;
    readonly events: readonly Record<string, unknown>[];
    readonly nativeEvents: readonly Record<string, unknown>[];
    readonly issues: readonly string[];
  }>(detailResponse);
  assert.equal(detail.id, 'run-a');
  assert.equal(detail.manifest?.run_id, 'run-a');
  assert.deepEqual(detail.events, olderEvents);
  assert.deepEqual(detail.nativeEvents, olderNative);
  assert.deepEqual(detail.issues, []);

  const unknown = await request(harness.port, '/api/runs/run-unknown');
  assert.equal(unknown.statusCode, 404);
});

test('lists all runs when the dashboard archive file is absent', async (t) => {
  const harness = await createHarness(t);
  await writeRun(harness.root, 'run-a', {
    manifest: runManifest('run-a'),
    metrics: runMetrics(),
  });
  await writeRun(harness.root, 'run-b', {
    manifest: runManifest('run-b'),
    metrics: runMetrics(),
  });

  const list = responseJson<{ readonly runs: readonly { readonly id: string }[] }>(await request(harness.port, '/api/runs'));
  assert.deepEqual(list.runs.map((run) => run.id), ['run-b', 'run-a']);
});

test('excludes archived runs from the list while keeping their details readable', async (t) => {
  const harness = await createHarness(t);
  await writeRun(harness.root, 'run-old', {
    manifest: runManifest('run-old'),
    metrics: runMetrics(),
    events: [{ seq: 1, type: 'run_finished' }],
  });
  await writeRun(harness.root, 'run-new', {
    manifest: runManifest('run-new'),
    metrics: runMetrics(),
  });
  await writeFile(
    path.join(harness.root, 'results', '.dashboard-archive.json'),
    serializeJson({
      schema_version: 1,
      archived_at: '2026-09-28T00:00:00.000Z',
      run_ids: ['run-old'],
    }),
    'utf8',
  );

  const list = responseJson<{ readonly runs: readonly { readonly id: string }[] }>(await request(harness.port, '/api/runs'));
  assert.deepEqual(list.runs.map((run) => run.id), ['run-new']);

  const detail = responseJson<{
    readonly id: string;
    readonly events: readonly { readonly seq?: number }[];
  }>(await request(harness.port, '/api/runs/run-old'));
  assert.equal(detail.id, 'run-old');
  assert.deepEqual(detail.events, [{ seq: 1, type: 'run_finished' }]);
});

test('fails closed when dashboard archive content is invalid', async (t) => {
  const harness = await createHarness(t);
  await writeRun(harness.root, 'run-visible', {
    manifest: runManifest('run-visible'),
    metrics: runMetrics(),
  });
  const archivePath = path.join(harness.root, 'results', '.dashboard-archive.json');
  const invalidArchives = [
    '{"schema_version":',
    serializeJson({ schema_version: 2, archived_at: '2026-09-28T00:00:00.000Z', run_ids: [] }),
    serializeJson({ schema_version: 1, archived_at: 'not-a-date', run_ids: [] }),
    serializeJson({ schema_version: 1, archived_at: '2026-09-28T00:00:00.000Z', run_ids: ['bad.id'] }),
    serializeJson({ schema_version: 1, archived_at: '2026-09-28T00:00:00.000Z', run_ids: ['batches'] }),
  ];

  for (const contents of invalidArchives) {
    await writeFile(archivePath, contents, 'utf8');
    assert.equal((await request(harness.port, '/api/runs')).statusCode, 500);
  }
});

test('fails closed when the dashboard archive path is a symlink', async (t) => {
  const harness = await createHarness(t);
  await writeRun(harness.root, 'run-visible', {
    manifest: runManifest('run-visible'),
    metrics: runMetrics(),
  });
  const outsideDirectory = path.join(harness.root, 'outside-archive');
  await mkdir(outsideDirectory, { recursive: true });
  const archivePath = path.join(harness.root, 'results', '.dashboard-archive.json');
  try {
    await symlink(outsideDirectory, archivePath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'EINVAL', 'UNKNOWN'].includes(errorCode(error) ?? '')) {
      t.skip(`symbolic link creation is unavailable: ${errorCode(error) ?? 'unknown'}`);
      return;
    }
    throw error;
  }

  assert.equal((await request(harness.port, '/api/runs')).statusCode, 500);
});

test('keeps good records while reporting bad JSON, JSONL, missing, and oversized files', async (t) => {
  const harness = await createHarness(t);
  await writeRun(harness.root, 'run-corrupt', {
    manifest: '{"run_id":',
    metrics: '[]\n',
    events: '{"seq":1}\nnot-json\n{"seq":2}\n[]\n',
    nativeEvents: '{"type":"tool/call"}\nnope\n',
  });
  await mkdir(path.join(harness.root, 'results', 'run-missing'), { recursive: true });
  await writeRun(harness.root, 'run-big', {
    manifest: Buffer.alloc(MAX_FILE_BYTES + 1, 0x61),
    metrics: runMetrics(),
  });

  const listResponse = await request(harness.port, '/api/runs');
  assert.equal(listResponse.statusCode, 200);
  const list = responseJson<{
    readonly runs: readonly {
      readonly id: string;
      readonly manifest: Record<string, unknown> | null;
      readonly metrics: Record<string, unknown> | null;
      readonly issues: readonly string[];
    }[];
  }>(listResponse);
  const corrupt = list.runs.find((run) => run.id === 'run-corrupt');
  const missing = list.runs.find((run) => run.id === 'run-missing');
  const oversized = list.runs.find((run) => run.id === 'run-big');
  assert.equal(corrupt?.manifest, null);
  assert.equal(corrupt?.metrics, null);
  assert.ok(corrupt?.issues.some((issue) => issue.includes('manifest.json contains invalid JSON')));
  assert.ok(corrupt?.issues.some((issue) => issue.includes('metrics.json must contain an object')));
  assert.ok(missing?.issues.includes('manifest.json is missing'));
  assert.ok(missing?.issues.includes('metrics.json is missing'));
  assert.ok(oversized?.issues.includes('manifest.json exceeds 8 MiB'));
  assert.equal(responseText(listResponse).includes(harness.root), false);

  const detail = responseJson<{
    readonly events: readonly { readonly seq?: number }[];
    readonly nativeEvents: readonly { readonly type?: string }[];
    readonly issues: readonly string[];
  }>(await request(harness.port, '/api/runs/run-corrupt'));
  assert.deepEqual(detail.events.map((event) => event.seq), [1, 2]);
  assert.deepEqual(detail.nativeEvents, [{ type: 'tool/call' }]);
  assert.ok(detail.issues.some((issue) => issue.includes('business-events.jsonl line 2')));
  assert.ok(detail.issues.some((issue) => issue.includes('business-events.jsonl line 4')));
  assert.ok(detail.issues.some((issue) => issue.includes('native-events.jsonl line 2')));
  assert.equal(JSON.stringify(detail).includes(harness.root), false);
});

test('returns an empty list without results and rejects invalid ids or encoded traversal', async (t) => {
  const harness = await createHarness(t);
  const empty = responseJson<{ readonly runs: readonly unknown[]; readonly truncated: boolean }>(
    await request(harness.port, '/api/runs'),
  );
  assert.deepEqual(empty, { runs: [], truncated: false });

  await writeRun(harness.root, 'run-valid', {
    manifest: runManifest('run-valid'),
    metrics: runMetrics(),
  });

  assert.equal((await request(harness.port, '/api/runs/bad.id')).statusCode, 400);
  for (const route of [
    '/api/runs/%2e%2e%2fsecret',
    '/api/runs/..%5csecret',
    '/api/runs/%2Fetc',
    '/%2e%2e%2fresults%2frun-valid%2fmanifest.json',
  ]) {
    const response = await request(harness.port, route);
    assert.ok(response.statusCode === 400 || response.statusCode === 404, route);
    assert.equal(responseText(response).includes(harness.root), false);
  }
});

test('enforces Host and Origin boundaries and rejects non-read methods', async (t) => {
  const harness = await createHarness(t);
  const wrongPort = harness.port === 65_535 ? 1 : harness.port + 1;

  assert.equal((await request(harness.port, '/api/runs', { headers: { host: `evil.example:${harness.port}` } })).statusCode, 403);
  assert.equal((await request(harness.port, '/api/runs', { headers: { host: `127.0.0.1:${wrongPort}` } })).statusCode, 403);
  assert.equal((await request(harness.port, '/api/runs', { headers: { origin: 'http://evil.example' } })).statusCode, 403);

  const allowed = await request(harness.port, '/api/runs', {
    headers: {
      host: `localhost:${harness.port}`,
      origin: `http://localhost:${harness.port}`,
    },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], undefined);

  const post = await request(harness.port, '/api/runs', { method: 'POST' });
  assert.equal(post.statusCode, 405);
  assert.equal((await request(harness.port, '/api/runs', { method: 'POST', headers: { origin: `http://127.0.0.1:${harness.port}` } })).statusCode, 405);
});

test('redacts the configured API key from every API response', async (t) => {
  const secret = 'dashboard-secret-value-123';
  const harness = await createHarness(t, secret);
  await writeRun(harness.root, 'run-secret', {
    manifest: { ...runManifest('run-secret'), model: `model-${secret}` },
    metrics: { ...runMetrics(), integrity_errors: [`leaked ${secret}`] },
    events: [{ seq: 1, type: 'note', data: { token: secret, note: secret } }],
    nativeEvents: [{ type: 'tool/result', data: { authorization: `Bearer ${secret}` } }],
  });

  const listResponse = await request(harness.port, '/api/runs');
  assert.equal(listResponse.statusCode, 200);
  assert.equal(responseText(listResponse).includes(secret), false);
  assert.equal(responseText(listResponse).includes('[REDACTED]'), true);

  const detailResponse = await request(harness.port, '/api/runs/run-secret');
  assert.equal(detailResponse.statusCode, 200);
  assert.equal(responseText(detailResponse).includes(secret), false);
  assert.equal(responseText(detailResponse).includes('[REDACTED]'), true);
});

test('limits lists to 500 runs and reports truncation', async (t) => {
  const harness = await createHarness(t);
  await Promise.all(Array.from({ length: 501 }, (_, index) => mkdir(
    path.join(harness.root, 'results', `run-${String(index).padStart(3, '0')}`),
    { recursive: true },
  )));

  const response = await request(harness.port, '/api/runs');
  assert.equal(response.statusCode, 200);
  const list = responseJson<{ readonly runs: readonly { readonly id: string }[]; readonly truncated: boolean }>(response);
  assert.equal(list.runs.length, 500);
  assert.equal(list.truncated, true);
  assert.equal(list.runs[0]?.id, 'run-500');
  assert.equal(list.runs.at(-1)?.id, 'run-001');
});

test('limits JSONL events to 20000 and reports truncation', async (t) => {
  const harness = await createHarness(t);
  const lines = `${Array.from({ length: MAX_EVENTS + 1 }, (_, index) => JSON.stringify({ n: index })).join('\n')}\n`;
  await writeRun(harness.root, 'run-many-events', {
    manifest: runManifest('run-many-events'),
    metrics: runMetrics(),
    events: lines,
    nativeEvents: [{ type: 'tool/call' }],
  });

  const detail = responseJson<{
    readonly events: readonly { readonly n?: number }[];
    readonly nativeEvents: readonly unknown[];
    readonly issues: readonly string[];
  }>(await request(harness.port, '/api/runs/run-many-events'));
  assert.equal(detail.events.length, MAX_EVENTS);
  assert.equal(detail.events[0]?.n, 0);
  assert.equal(detail.events.at(-1)?.n, MAX_EVENTS - 1);
  assert.equal(detail.nativeEvents.length, 1);
  assert.ok(detail.issues.some((issue) => issue.includes('exceeds 20000 events')));
});

test('rejects symlink or junction run directories when the platform permits creating them', async (t) => {
  const harness = await createHarness(t);
  const outside = path.join(harness.root, 'outside-run');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'manifest.json'), serializeJson(runManifest('outside-run')), 'utf8');

  const results = path.join(harness.root, 'results');
  await mkdir(results, { recursive: true });
  const linkedRun = path.join(results, 'run-linked');
  try {
    await symlink(outside, linkedRun, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'EINVAL', 'UNKNOWN'].includes(errorCode(error) ?? '')) {
      t.skip(`symbolic link creation is unavailable: ${errorCode(error) ?? 'unknown'}`);
      return;
    }
    throw error;
  }

  const list = responseJson<{ readonly runs: readonly { readonly id: string }[] }>(await request(harness.port, '/api/runs'));
  assert.deepEqual(list.runs, []);
  assert.equal((await request(harness.port, '/api/runs/run-linked')).statusCode, 404);
});
