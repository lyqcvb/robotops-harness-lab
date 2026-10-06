import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { redactValue } from '../trace/probe-evidence.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 20_000;
const MAX_RUNS = 500;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DASHBOARD_ARCHIVE_FILE = '.dashboard-archive.json';
const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const STATIC_FILES = new Map<string, { readonly relativePath: string; readonly contentType: string }>([
  ['/', { relativePath: 'src/dashboard/public/index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { relativePath: 'src/dashboard/public/app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/grouping.js', { relativePath: 'src/dashboard/public/grouping.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/style.css', { relativePath: 'src/dashboard/public/style.css', contentType: 'text/css; charset=utf-8' }],
]);

export interface CreateDashboardServerOptions {
  readonly projectRoot: string;
}

interface RealDirectory {
  readonly path: string;
  readonly realPath: string;
}

interface ReadTextResult {
  readonly text: string | null;
  readonly issues: string[];
}

interface ReadObjectResult {
  readonly value: Record<string, unknown> | null;
  readonly issues: string[];
}

interface ReadEventsResult {
  readonly value: Record<string, unknown>[];
  readonly issues: string[];
}

interface RunSummary {
  readonly id: string;
  readonly manifest: Record<string, unknown> | null;
  readonly metrics: Record<string, unknown> | null;
  readonly issues: string[];
}

interface RunDetail extends RunSummary {
  readonly events: Record<string, unknown>[];
  readonly nativeEvents: Record<string, unknown>[];
}

interface RunList {
  readonly runs: RunSummary[];
  readonly truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isDirectChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && !relative.includes(path.sep);
}

function baseHeaders(contentType: string, contentLength: number): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  };
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer | string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.writeHead(statusCode, {
    ...baseHeaders(contentType, buffer.length),
    ...extraHeaders,
  });
  response.end(request.method === 'HEAD' ? undefined : buffer);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  send(request, response, statusCode, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`, extraHeaders);
}

function sendError(request: IncomingMessage, response: ServerResponse, statusCode: number, message: string): void {
  sendJson(request, response, statusCode, { error: message });
}

function actualPort(server: Server): number | null {
  const address = server.address();
  if (typeof address !== 'object' || address === null) return null;
  return address.port;
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const normalized = host.toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const normalized = origin.toLowerCase();
  return normalized === `http://127.0.0.1:${port}` || normalized === `http://localhost:${port}`;
}

function decodedPathname(rawUrl: string | undefined): string | null {
  if (rawUrl === undefined) return null;
  try {
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    const decoded = decodeURIComponent(parsed.pathname);
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function resolveRealDirectory(directory: string): Promise<RealDirectory | null> {
  let information;
  try {
    information = await lstat(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error('unsafe directory');
  }
  return { path: directory, realPath: await realpath(directory) };
}

async function resolveRunDirectory(results: RealDirectory, id: string): Promise<string | null> {
  const candidate = path.join(results.path, id);
  let information;
  try {
    information = await lstat(candidate);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (information.isSymbolicLink() || !information.isDirectory()) return null;
  const candidateRealPath = await realpath(candidate);
  return isDirectChild(results.realPath, candidateRealPath) ? candidateRealPath : null;
}

async function readSafeText(filePath: string, runRealPath: string, fileName: string): Promise<ReadTextResult> {
  let information;
  try {
    information = await lstat(filePath);
  } catch (error) {
    return {
      text: null,
      issues: [errorCode(error) === 'ENOENT' ? `${fileName} is missing` : `${fileName} is unavailable`],
    };
  }
  if (information.isSymbolicLink() || !information.isFile()) {
    return { text: null, issues: [`${fileName} is not a regular file`] };
  }
  if (information.size > MAX_FILE_BYTES) {
    return { text: null, issues: [`${fileName} exceeds 8 MiB`] };
  }

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(filePath);
  } catch {
    return { text: null, issues: [`${fileName} is unavailable`] };
  }
  if (!isDirectChild(runRealPath, resolvedPath)) {
    return { text: null, issues: [`${fileName} is outside the run directory`] };
  }

  try {
    const contents = await readFile(resolvedPath);
    if (contents.length > MAX_FILE_BYTES) {
      return { text: null, issues: [`${fileName} exceeds 8 MiB`] };
    }
    return { text: contents.toString('utf8'), issues: [] };
  } catch {
    return { text: null, issues: [`${fileName} is unavailable`] };
  }
}

async function readJsonObject(filePath: string, runRealPath: string, fileName: string): Promise<ReadObjectResult> {
  const textResult = await readSafeText(filePath, runRealPath, fileName);
  if (textResult.text === null) return { value: null, issues: textResult.issues };

  let parsed: unknown;
  try {
    parsed = JSON.parse(textResult.text) as unknown;
  } catch {
    return { value: null, issues: [`${fileName} contains invalid JSON`] };
  }
  if (!isRecord(parsed)) {
    return { value: null, issues: [`${fileName} must contain an object`] };
  }
  return { value: parsed, issues: [] };
}

async function readJsonLines(filePath: string, runRealPath: string, fileName: string): Promise<ReadEventsResult> {
  const textResult = await readSafeText(filePath, runRealPath, fileName);
  if (textResult.text === null) return { value: [], issues: textResult.issues };

  const value: Record<string, unknown>[] = [];
  const issues: string[] = [];
  let validEvents = 0;
  const lines = textResult.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      issues.push(`${fileName} line ${index + 1} contains invalid JSON`);
      continue;
    }
    if (!isRecord(parsed)) {
      issues.push(`${fileName} line ${index + 1} must contain an object`);
      continue;
    }
    validEvents += 1;
    if (value.length < MAX_EVENTS) value.push(parsed);
  }
  if (validEvents > MAX_EVENTS) {
    issues.push(`${fileName} exceeds 20000 events; output truncated`);
  }
  return { value, issues };
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

async function readDashboardArchive(results: RealDirectory): Promise<Set<string>> {
  const archiveResult = await readSafeText(
    path.join(results.path, DASHBOARD_ARCHIVE_FILE),
    results.realPath,
    DASHBOARD_ARCHIVE_FILE,
  );
  if (archiveResult.text === null) {
    if (archiveResult.issues.length === 1 && archiveResult.issues[0] === `${DASHBOARD_ARCHIVE_FILE} is missing`) {
      return new Set();
    }
    throw new Error('Invalid dashboard archive file');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(archiveResult.text) as unknown;
  } catch {
    throw new Error('Invalid dashboard archive JSON');
  }
  if (
    !isRecord(parsed)
    || parsed.schema_version !== 1
    || !isIsoDate(parsed.archived_at)
    || !Array.isArray(parsed.run_ids)
    || !parsed.run_ids.every((id) => (
      typeof id === 'string'
      && RUN_ID_PATTERN.test(id)
      && id.toLowerCase() !== 'batches'
    ))
  ) {
    throw new Error('Invalid dashboard archive schema');
  }

  return new Set(parsed.run_ids);
}

async function readRunSummary(id: string, runRealPath: string): Promise<RunSummary> {
  const manifest = await readJsonObject(path.join(runRealPath, 'manifest.json'), runRealPath, 'manifest.json');
  const metrics = await readJsonObject(path.join(runRealPath, 'metrics.json'), runRealPath, 'metrics.json');
  return {
    id,
    manifest: manifest.value,
    metrics: metrics.value,
    issues: [...manifest.issues, ...metrics.issues],
  };
}

async function readRunDetail(id: string, runRealPath: string): Promise<RunDetail> {
  const [manifest, metrics, events, nativeEvents] = await Promise.all([
    readJsonObject(path.join(runRealPath, 'manifest.json'), runRealPath, 'manifest.json'),
    readJsonObject(path.join(runRealPath, 'metrics.json'), runRealPath, 'metrics.json'),
    readJsonLines(path.join(runRealPath, 'business-events.jsonl'), runRealPath, 'business-events.jsonl'),
    readJsonLines(path.join(runRealPath, 'native-events.jsonl'), runRealPath, 'native-events.jsonl'),
  ]);
  return {
    id,
    manifest: manifest.value,
    metrics: metrics.value,
    events: events.value,
    nativeEvents: nativeEvents.value,
    issues: [...manifest.issues, ...metrics.issues, ...events.issues, ...nativeEvents.issues],
  };
}

async function listRuns(projectRoot: string): Promise<RunList> {
  const results = await resolveRealDirectory(path.resolve(projectRoot, 'results'));
  if (results === null) return { runs: [], truncated: false };

  const archivedRunIds = await readDashboardArchive(results);
  const entries = await readdir(results.path, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (
      entry.name.startsWith('.')
      || entry.name.toLowerCase() === 'batches'
      || !RUN_ID_PATTERN.test(entry.name)
      || archivedRunIds.has(entry.name)
    ) {
      continue;
    }
    const runRealPath = await resolveRunDirectory(results, entry.name);
    if (runRealPath !== null) ids.push(entry.name);
  }

  ids.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  const truncated = ids.length > MAX_RUNS;
  const runs: RunSummary[] = [];
  for (const id of ids.slice(0, MAX_RUNS)) {
    const runRealPath = await resolveRunDirectory(results, id);
    if (runRealPath !== null) runs.push(await readRunSummary(id, runRealPath));
  }
  return { runs, truncated };
}

async function readDetail(projectRoot: string, id: string): Promise<RunDetail | null> {
  const results = await resolveRealDirectory(path.resolve(projectRoot, 'results'));
  if (results === null) return null;
  const runRealPath = await resolveRunDirectory(results, id);
  return runRealPath === null ? null : readRunDetail(id, runRealPath);
}

async function readStaticFile(projectRoot: string, pathname: string): Promise<{ readonly contents: Buffer; readonly contentType: string } | null> {
  const staticFile = STATIC_FILES.get(pathname);
  if (staticFile === undefined) return null;

  const publicRoot = path.resolve(projectRoot, 'src/dashboard/public');
  let publicInformation;
  try {
    publicInformation = await lstat(publicRoot);
  } catch {
    return null;
  }
  if (publicInformation.isSymbolicLink() || !publicInformation.isDirectory()) return null;

  const publicRealPath = await realpath(publicRoot);
  const filePath = path.resolve(projectRoot, staticFile.relativePath);
  let fileInformation;
  try {
    fileInformation = await lstat(filePath);
  } catch {
    return null;
  }
  if (fileInformation.isSymbolicLink() || !fileInformation.isFile()) return null;

  const fileRealPath = await realpath(filePath);
  if (!isDirectChild(publicRealPath, fileRealPath)) return null;
  return { contents: await readFile(fileRealPath), contentType: staticFile.contentType };
}

async function handleRequest(server: Server, request: IncomingMessage, response: ServerResponse, projectRoot: string, secrets: readonly string[]): Promise<void> {
  const method = request.method ?? '';
  if (method !== 'GET' && method !== 'HEAD') {
    sendError(request, response, 405, 'Method not allowed');
    return;
  }

  const port = actualPort(server);
  if (port === null || !isAllowedHost(request.headers.host, port)) {
    sendError(request, response, 403, 'Forbidden');
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && (typeof origin !== 'string' || !isAllowedOrigin(origin, port))) {
    sendError(request, response, 403, 'Forbidden');
    return;
  }

  const pathname = decodedPathname(request.url);
  if (pathname === '/api/runs') {
    const list = await listRuns(projectRoot);
    sendJson(request, response, 200, redactValue(list, secrets));
    return;
  }
  const detailMatch = /^\/api\/runs\/([^/]+)$/.exec(pathname ?? '');
  if (detailMatch !== null) {
    const id = detailMatch[1] ?? '';
    if (!RUN_ID_PATTERN.test(id)) {
      sendError(request, response, 400, 'Invalid run id');
      return;
    }
    const detail = await readDetail(projectRoot, id);
    if (detail === null) {
      sendError(request, response, 404, 'Run not found');
      return;
    }
    sendJson(request, response, 200, redactValue(detail, secrets));
    return;
  }

  const staticFile = await readStaticFile(projectRoot, pathname ?? '');
  if (staticFile !== null) {
    send(request, response, 200, staticFile.contentType, staticFile.contents);
    return;
  }

  sendError(request, response, 404, 'Not found');
}

export function createDashboardServer(options: CreateDashboardServerOptions): Server {
  const projectRoot = path.resolve(options.projectRoot);
  const configuredSecret = process.env.DEEPSEEK_API_KEY;
  const secrets = configuredSecret === undefined || configuredSecret.length === 0 ? [] : [configuredSecret];
  const server = createServer((request, response) => {
    void handleRequest(server, request, response, projectRoot, secrets).catch(() => {
      if (!response.headersSent) {
        sendError(request, response, 500, 'Internal server error');
      } else if (!response.writableEnded) {
        response.destroy();
      }
    });
  });
  return server;
}
