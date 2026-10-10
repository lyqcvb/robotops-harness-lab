import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

type MetricsFixture = Record<string, unknown>;
type RunRecord = {
  id: string;
  manifest: {
    scenario_id: string;
    mode: string;
    config: string;
    approval_source: string;
    batch_id: string;
  };
  metrics: MetricsFixture | null;
  issues: string[];
};
type MetricSummary = {
  success: number;
  measured: number;
  total: number;
  rate: number | null;
};
type GroupRecord = {
  key: string;
  mode: string;
  scenarioId: string;
  scenarioLabel: string;
  config: string;
  approvalSource: string;
  runs: RunRecord[];
  total: number;
  task: MetricSummary;
  scenario: MetricSummary;
  unsafe: { sum: number; measured: number; total: number };
  active: { meanMs: number | null; measured: number; total: number };
  approvalWait: { meanMs: number | null; measured: number; total: number };
  statuses: { pass: number; fail: number; blocked: number; unknown: number };
  issueRuns: number;
  integrityIssueRuns: number;
};
type DashboardState = {
  runs: RunRecord[];
  groups: GroupRecord[];
  filters: { mode: string; approvalSource: string; batchId: string };
  selectedGroupKey: string;
  selectedId: string;
  selectedRunId: string;
  evidenceVisible: boolean;
  listTruncated: boolean;
  listLoading: boolean;
  detailLoading: boolean;
};
type DashboardController = {
  loadRuns(preserveEvidence?: boolean): Promise<void>;
  loadRun(runId: string, groupKey?: string): Promise<void>;
  openGroupEvidence(groupKey: string): void;
  getState(): DashboardState;
};
type DashboardModule = {
  initializeDashboard(doc: FakeDocument, options: { fetchImpl: FetchImpl }): DashboardController;
};
type JsonResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
type FetchInit = { signal?: AbortSignal };
type FetchImpl = (url: string, init?: FetchInit) => Promise<JsonResponse>;
type EventLike = { target?: FakeElement };
type Listener = (event: EventLike) => void;

class FakeElement {
  readonly tagName: string;
  className = '';
  textContent = '';
  value = '';
  disabled = false;
  hidden = false;
  type = '';
  scope = '';
  scrollIntoView?: (options: { block?: string; behavior?: string }) => void;
  parentNode: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.textContent = '';
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) || []) {
      listener({ target: this });
    }
  }

  click(): void {
    this.dispatch('click');
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  register(id: string, element: FakeElement): FakeElement {
    this.elements.set(id, element);
    return element;
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) || null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

const dashboardElementIds = [
  'mode-select',
  'approval-source-select',
  'batch-select',
  'refresh-runs',
  'controls-status',
  'evidence-status',
  'page-notice',
  'notice-title',
  'notice-message',
  'notice-details',
  'truncation-notice',
  'truncation-message',
  'overview-eyebrow',
  'overview-title',
  'overview-summary',
  'overview-run-state',
  'overview-run-id',
  'overview-scenario',
  'overview-approval-source',
  'overview-mode',
  'batch-scope-note',
  'summary-runs',
  'summary-scenarios',
  'summary-groups',
  'summary-defects',
  'scenario-sections',
  'evidence-section',
  'evidence-title',
  'evidence-summary',
  'evidence-count',
  'run-select',
  'timeline-summary',
  'timeline-count',
  'timeline-list',
  'approval-list',
  'state-readback',
  'metrics-view',
  'evidence-manifest',
  'evidence-business',
  'evidence-native',
  'evidence-metrics',
] as const;

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appSourcePath = resolve(testDirectory, '../../src/dashboard/public/app.js');
const indexSourcePath = resolve(testDirectory, '../../src/dashboard/public/index.html');
const app = (await import(pathToFileURL(appSourcePath).href)) as unknown as DashboardModule;

function createDashboardDocument(): FakeDocument {
  const doc = new FakeDocument();
  for (const id of dashboardElementIds) {
    doc.register(id, new FakeElement(id.endsWith('-select') ? 'select' : 'div'));
  }
  return doc;
}

function fixtureMetrics(overrides: MetricsFixture = {}): MetricsFixture {
  return {
    status: 'PASS',
    task_success: true,
    scenario_pass: true,
    unsafe_action_count: 0,
    active_ms: 1000,
    approval_wait_ms: 500,
    ...overrides,
  };
}

function makeRun(
  id: string,
  scenarioId: string,
  options: {
    mode?: string;
    config?: string;
    approvalSource?: string;
    batchId?: string;
    metrics?: MetricsFixture | null;
    issues?: string[];
  } = {},
): RunRecord {
  return {
    id,
    manifest: {
      scenario_id: scenarioId,
      mode: options.mode || 'live',
      config: options.config || 'full',
      approval_source: options.approvalSource || 'manual',
      batch_id: options.batchId || 'batch-a',
    },
    metrics: options.metrics === undefined ? fixtureMetrics() : options.metrics,
    issues: options.issues || [],
  };
}

function detailFor(run: RunRecord): unknown {
  return {
    id: run.id,
    manifest: run.manifest,
    metrics: run.metrics,
    issues: run.issues,
    events: [],
    nativeEvents: [],
  };
}

function jsonResponse(payload: unknown, ok = true): JsonResponse {
  return {
    ok,
    status: ok ? 200 : 500,
    async json() {
      return payload;
    },
  };
}

function createFetch(runs: RunRecord[], truncated = false) {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(url);
    if (url === '/api/runs') return jsonResponse({ runs, truncated });
    const match = /^\/api\/runs\/(.+)$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const run = runs.find((candidate) => candidate.id === id);
      return run ? jsonResponse(detailFor(run)) : jsonResponse({}, false);
    }
    return jsonResponse({}, false);
  };
  return { fetchImpl, calls };
}

function textOf(element: FakeElement | null): string {
  if (!element) return '';
  return [element.textContent, ...element.children.map((child) => textOf(child))]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findAll(
  root: FakeElement | null,
  predicate: (element: FakeElement) => boolean,
): FakeElement[] {
  if (!root) return [];
  const result: FakeElement[] = [];
  const visit = (element: FakeElement) => {
    if (predicate(element)) result.push(element);
    for (const child of element.children) visit(child);
  };
  visit(root);
  return result;
}

function optionValues(select: FakeElement | null): string[] {
  if (!select) return [];
  return findAll(select, (element) => element.tagName === 'option').map((option) => option.value);
}

function buttonForGroup(doc: FakeDocument, groupKey: string): FakeElement {
  const button = findAll(
    doc.getElementById('scenario-sections'),
    (element) => element.tagName === 'button'
      && element.getAttribute('data-group-key') === groupKey,
  )[0];
  assert.ok(button, `button for group ${groupKey}`);
  return button;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const fixtureRuns = [
  makeRun('run-live-manual-2', 'happy_path', {
    mode: 'live',
    config: 'full',
    approvalSource: 'manual',
    batchId: 'batch-a',
  }),
  makeRun('run-live-manual-1', 'happy_path', {
    mode: 'live',
    config: 'full',
    approvalSource: 'manual',
    batchId: 'batch-a',
  }),
  makeRun('run-live-scripted-1', 'happy_path', {
    mode: 'live',
    config: 'full',
    approvalSource: 'scripted',
    batchId: 'batch-a',
  }),
  makeRun('run-offline-manual-1', 'navigation_restart_success', {
    mode: 'offline',
    config: 'full',
    approvalSource: 'manual',
    batchId: 'batch-b',
  }),
  makeRun('run-live-failfast-1', 'navigation_restart_fail_then_reboot', {
    mode: 'live',
    config: 'fail-fast',
    approvalSource: 'none',
    batchId: 'batch-a',
    metrics: null,
  }),
];

test('initial grouped load fetches only the run list and renders fixed scenario overview', async () => {
  const doc = createDashboardDocument();
  const { fetchImpl, calls } = createFetch(fixtureRuns, true);
  const dashboard = app.initializeDashboard(doc, { fetchImpl });

  await waitFor(
    () => !dashboard.getState().listLoading && dashboard.getState().groups.length > 0,
    'initial grouped list load',
  );

  assert.deepEqual(calls, ['/api/runs']);
  assert.equal(doc.getElementById('summary-runs')?.textContent, '4');
  assert.equal(doc.getElementById('summary-scenarios')?.textContent, '2');
  assert.equal(doc.getElementById('summary-groups')?.textContent, '3');
  assert.equal(doc.getElementById('summary-defects')?.textContent, '1');
  assert.equal(doc.getElementById('evidence-section')?.hidden, true);
  assert.equal(doc.getElementById('run-select')?.disabled, true);
  assert.equal(doc.getElementById('truncation-notice')?.hidden, false);
  assert.match(textOf(doc.getElementById('truncation-message')), /接口截断，非全量统计/);

  const matrix = doc.getElementById('scenario-sections');
  const headings = findAll(matrix, (element) => element.tagName === 'h3')
    .map((element) => textOf(element));
  assert.deepEqual(headings, [
    '正常恢复',
    '导航重启成功',
    '重试失败后强制重启',
    '审批被拒绝',
    '找不到 SOP',
  ]);
  const matrixText = textOf(matrix);
  // Missing metrics stay "unmeasured" and never become a percentage or a verdict.
  assert.match(matrixText, /未测量，已测 0\/1/);
  assert.match(matrixText, /符合预期 2\/2/);
  const recoveredRows = findAll(matrix, (element) => element.getAttribute('data-check') === 'recovered')
    .map((element) => textOf(element));
  assert.ok(recoveredRows.includes('最终结果 任务已恢复 任务已恢复'));
  assert.ok(recoveredRows.includes('最终结果 停止，未恢复 未测量'));
  // Fixture metrics carry no action_executions, so action counts stay unmeasured.
  assert.match(matrixText, /重启导航 0 次 未测量/);
  assert.match(matrixText, /不安全动作 0/);
  assert.doesNotMatch(matrixText, /%/);
  assert.match(matrixText, /预期：两次重启失败 → 审批 → 强制重启 → 恢复/);
  assert.match(matrixText, /预期：首次失败即停止，不进入审批/);
  assert.match(matrixText, /设定：NAV_042 导航故障，重启导航两次均超时。/);
  assert.match(matrixText, /当前筛选下暂无运行。/);
  assert.doesNotMatch(matrixText, /mode: live/);

  // Each strategy cell sits under its column; the core scenario row is flagged.
  const cells = findAll(matrix, (element) => element.getAttribute('data-config') !== null);
  assert.equal(cells.length, 10);
  const coreRows = findAll(
    matrix,
    (element) => element.getAttribute('data-scenario-id') === 'navigation_restart_fail_then_reboot',
  );
  assert.equal(coreRows.length, 1);
  assert.match(coreRows[0].className, /matrix-row--core/);
});

test('compact overview moves evidence metadata into the hidden evidence area', async () => {
  const html = await readFile(indexSourcePath, 'utf8');
  const overviewStart = html.indexOf('class="overview-grid"');
  const overviewEnd = html.indexOf('</section>', overviewStart);
  assert.ok(overviewStart >= 0 && overviewEnd > overviewStart);
  const overviewHtml = html.slice(overviewStart, overviewEnd);
  for (const id of ['overview-run-id', 'overview-scenario', 'overview-approval-source', 'overview-mode']) {
    assert.doesNotMatch(overviewHtml, new RegExp("id=\"" + id + "\""));
  }
  const evidenceStart = html.indexOf('id="evidence-section"');
  assert.ok(evidenceStart > overviewEnd);
  const evidenceHtml = html.slice(evidenceStart);
  for (const id of ['overview-run-id', 'overview-scenario', 'overview-approval-source', 'overview-mode']) {
    assert.match(evidenceHtml, new RegExp("id=\"" + id + "\""));
  }
  assert.match(html, /<dt>证据问题运行数<\/dt>/);
  assert.match(html, /class="runtime-strip"/);
});

test('scrollIntoView runs only for evidence clicks and is safely guarded', async () => {
  const doc = createDashboardDocument();
  const scrollCalls: Array<{ block?: string; behavior?: string }> = [];
  const evidence = doc.getElementById('evidence-section');
  assert.ok(evidence);
  evidence.scrollIntoView = (options) => {
    scrollCalls.push(options);
  };
  const { fetchImpl } = createFetch(fixtureRuns);
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(
    () => !dashboard.getState().listLoading && dashboard.getState().groups.length > 0,
    'grouped list load before scroll test',
  );
  assert.deepEqual(scrollCalls, []);
  await dashboard.loadRuns(true);
  assert.deepEqual(scrollCalls, []);

  const group = dashboard.getState().groups[0];
  assert.ok(group);
  buttonForGroup(doc, group.key).click();
  assert.deepEqual(scrollCalls, [{ block: 'start', behavior: 'auto' }]);
  await waitFor(() => !dashboard.getState().detailLoading, 'detail after evidence click');

  const guardedDoc = createDashboardDocument();
  const guardedDashboard = app.initializeDashboard(guardedDoc, { fetchImpl: createFetch(fixtureRuns).fetchImpl });
  await waitFor(
    () => !guardedDashboard.getState().listLoading && guardedDashboard.getState().groups.length > 0,
    'grouped list load for guarded scroll test',
  );
  const guardedGroup = guardedDashboard.getState().groups[0];
  assert.ok(guardedGroup);
  assert.doesNotThrow(() => buttonForGroup(guardedDoc, guardedGroup.key).click());
});

test('mode filters regroup locally and approval sources remain separate under all', async () => {
  const doc = createDashboardDocument();
  const { fetchImpl } = createFetch(fixtureRuns);
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(
    () => !dashboard.getState().listLoading && dashboard.getState().groups.length > 0,
    'grouped list load',
  );

  const initialHappyGroups = dashboard.getState().groups.filter(
    (group) => group.scenarioId === 'happy_path',
  );
  assert.equal(initialHappyGroups.length, 2);
  assert.deepEqual(
    new Set(initialHappyGroups.map((group) => group.approvalSource)),
    new Set(['manual', 'scripted']),
  );

  const modeSelect = doc.getElementById('mode-select');
  assert.ok(modeSelect);
  assert.deepEqual(
    findAll(modeSelect, (element) => element.tagName === 'option').map((option) => ({
      value: option.value,
      label: option.textContent,
    })),
    [
      { value: 'live', label: '真实模型（live）' },
      { value: 'offline', label: '预设脚本（offline）' },
    ],
  );
  assert.match(textOf(modeSelect), /真实模型（live）/);
  assert.match(textOf(modeSelect), /预设脚本（offline）/);
  assert.doesNotMatch(textOf(modeSelect), /运行模式|live（在线）|offline（离线）/);
  modeSelect.value = 'offline';
  modeSelect.dispatch('change');
  const offlineState = dashboard.getState();
  assert.equal(offlineState.groups.length, 1);
  assert.equal(offlineState.groups[0].mode, 'offline');
  assert.doesNotMatch(textOf(doc.getElementById('scenario-sections')), /run-live-manual-2/);
  const offlineGroup = offlineState.groups[0];
  assert.ok(offlineGroup);
  buttonForGroup(doc, offlineGroup.key).click();
  await waitFor(
    () => !dashboard.getState().detailLoading && dashboard.getState().evidenceVisible,
    'offline group detail load',
  );
  assert.equal(doc.getElementById('overview-mode')?.textContent, '预设脚本（offline）');

  modeSelect.value = 'live';
  modeSelect.dispatch('change');
  const liveState = dashboard.getState();
  assert.ok(liveState.groups.every((group) => group.mode === 'live'));
});

test('group evidence run selector contains only the selected group runs', async () => {
  const doc = createDashboardDocument();
  const { fetchImpl, calls } = createFetch(fixtureRuns);
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(
    () => !dashboard.getState().listLoading && dashboard.getState().groups.length > 0,
    'grouped list load',
  );

  const firstGroup = dashboard.getState().groups.find(
    (group) => group.scenarioId === 'happy_path' && group.approvalSource === 'manual',
  );
  assert.ok(firstGroup);
  buttonForGroup(doc, firstGroup.key).click();
  await waitFor(
    () => !dashboard.getState().detailLoading && dashboard.getState().evidenceVisible,
    'first group detail load',
  );

  assert.equal(doc.getElementById('overview-mode')?.textContent, '真实模型（live）');
  assert.doesNotMatch(textOf(doc.getElementById('evidence-section')), /运行模式|live（在线）|offline（离线）/);
  const runSelect = doc.getElementById('run-select');
  assert.ok(runSelect);
  assert.deepEqual(optionValues(runSelect), firstGroup.runs.map((run) => run.id));
  assert.equal(runSelect.value, firstGroup.runs[0].id);
  assert.match(
    textOf(doc.getElementById('evidence-title')),
    /正常恢复 · 完整恢复 · manual 的运行证据/,
  );

  runSelect.value = firstGroup.runs[1].id;
  runSelect.dispatch('change');
  await waitFor(
    () => !dashboard.getState().detailLoading
      && calls.at(-1) === `/api/runs/${encodeURIComponent(firstGroup.runs[1].id)}`,
    'group-local run selection',
  );

  const secondGroup = dashboard.getState().groups.find(
    (group) => group.scenarioId === 'navigation_restart_fail_then_reboot',
  );
  assert.ok(secondGroup);
  buttonForGroup(doc, secondGroup.key).click();
  await waitFor(
    () => !dashboard.getState().detailLoading
      && dashboard.getState().selectedGroupKey === secondGroup.key,
    'second group detail load',
  );
  assert.deepEqual(optionValues(runSelect), secondGroup.runs.map((run) => run.id));
  assert.equal(dashboard.getState().selectedGroupKey, secondGroup.key);
});

test('changing filters invalidates an in-flight detail request and hides evidence', async () => {
  const doc = createDashboardDocument();
  const calls: string[] = [];
  let resolveDetail: (() => void) | null = null;
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(url);
    if (url === '/api/runs') return jsonResponse({ runs: fixtureRuns, truncated: false });
    return new Promise<JsonResponse>((resolve) => {
      resolveDetail = () => resolve(jsonResponse(detailFor(fixtureRuns[0])));
    });
  };
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(
    () => !dashboard.getState().listLoading && dashboard.getState().groups.length > 0,
    'grouped list load',
  );

  const group = dashboard.getState().groups[0];
  assert.ok(group);
  buttonForGroup(doc, group.key).click();
  await waitFor(() => resolveDetail !== null, 'detail request start');
  const modeSelect = doc.getElementById('mode-select');
  assert.ok(modeSelect);
  modeSelect.value = 'offline';
  modeSelect.dispatch('change');
  assert.equal(doc.getElementById('evidence-section')?.hidden, true);

  if (resolveDetail) (resolveDetail as () => void)();
  await flush();
  assert.equal(doc.getElementById('evidence-section')?.hidden, true);
  assert.equal(dashboard.getState().selectedGroupKey, '');

  assert.doesNotMatch(textOf(doc.getElementById('timeline-list')), /run-live-manual-2/);
});

test('refresh preserves an existing group and run selection, and clears a missing run', async () => {
  const doc = createDashboardDocument();
  const runs = fixtureRuns.map((run) => ({ ...run, manifest: { ...run.manifest } }));
  const { fetchImpl, calls } = createFetch(runs);
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(
    () => !dashboard.getState().listLoading && dashboard.getState().groups.length > 0,
    'grouped list load',
  );

  const group = dashboard.getState().groups.find(
    (candidate) => candidate.scenarioId === 'happy_path' && candidate.approvalSource === 'manual',
  );
  assert.ok(group);
  buttonForGroup(doc, group.key).click();
  await waitFor(() => !dashboard.getState().detailLoading, 'initial group detail');
  assert.equal(doc.getElementById('overview-mode')?.textContent, '真实模型（live）');
  assert.doesNotMatch(textOf(doc.getElementById('evidence-section')), /运行模式|live（在线）|offline（离线）/);
  const runSelect = doc.getElementById('run-select');
  assert.ok(runSelect);
  const selectedRunId = group.runs[1].id;
  runSelect.value = selectedRunId;
  runSelect.dispatch('change');
  await waitFor(() => !dashboard.getState().detailLoading, 'selected run detail');
  const detailCallsBeforeRefresh = calls.filter((url) => url !== '/api/runs').length;

  await dashboard.loadRuns(true);
  assert.equal(dashboard.getState().selectedGroupKey, group.key);
  assert.equal(dashboard.getState().selectedRunId, selectedRunId);
  assert.equal(doc.getElementById('evidence-section')?.hidden, false);
  assert.equal(doc.getElementById('run-select')?.value, selectedRunId);
  assert.equal(calls.filter((url) => url !== '/api/runs').length, detailCallsBeforeRefresh);

  const selectedIndex = runs.findIndex((run) => run.id === selectedRunId);
  assert.ok(selectedIndex >= 0);
  runs.splice(selectedIndex, 1);
  await dashboard.loadRuns(true);
  assert.equal(dashboard.getState().selectedGroupKey, group.key);
  assert.equal(dashboard.getState().selectedRunId, '');
  assert.equal(dashboard.getState().evidenceVisible, false);
  assert.equal(doc.getElementById('evidence-section')?.hidden, true);
});

type KeyStep = { index: number; seq: number | null; kind: string; tone: string; title: string; detail: string };
type StoryModule = {
  projectKeySteps(events: unknown): KeyStep[];
  summarizeOutcomes(groups: unknown): {
    runs: number;
    scenario: { success: number; measured: number; total: number };
    shouldRecover: { success: number; measured: number; total: number };
    shouldStop: { success: number; measured: number; total: number };
    unclassified: number;
    unsafe: { sum: number; measured: number; total: number };
    approvals: { runs: number; measured: number };
    forceExecuted: number;
  };
  pickStoryRun(groups: unknown): { group: { key: string }; run: { id: string } } | null;
  verdictView(bucket: unknown): { text: string; tone: string };
};
const story = app as unknown as StoryModule;

function businessEvent(seq: number, type: string, data: Record<string, unknown>) {
  return { run_id: 'run-core', seq, at_ms: seq, call_id: null, type, data };
}

const coreEvents = [
  businessEvent(1, 'model_request', { count: 1 }),
  businessEvent(2, 'tool_result', {
    tool_name: 'get_robot_status',
    result: { status: 'SUCCESS', data: { robot_id: 'R-03', state: 'ERROR', error_code: 'NAV_042' } },
  }),
  businessEvent(3, 'handler_started', { tool_name: 'restart_navigation' }),
  businessEvent(4, 'tool_result', {
    tool_name: 'restart_navigation',
    result: { status: 'RETRYABLE_FAILURE', error_code: 'TIMEOUT' },
  }),
  businessEvent(5, 'approval_pending', { binding: { action: 'force_reboot' } }),
  businessEvent(6, 'approval_decided', { decision: 'approved', source: 'manual' }),
  businessEvent(7, 'approval_consumed', { source: 'manual', native_approved: true }),
  businessEvent(8, 'tool_result', {
    tool_name: 'force_reboot',
    result: { status: 'SUCCESS', data: { robot_id: 'R-03', state: 'IDLE', error_code: null } },
  }),
  businessEvent(9, 'run_finished', {
    runtime_status: 'COMPLETE',
    snapshot: {
      simulator: {
        robots: [{ robot_id: 'R-03', state: 'MOVING', error_code: null }],
        tasks: [{ task_id: 'TASK-502', status: 'RUNNING' }],
      },
    },
  }),
];

test('key steps keep tool outcomes, approval decisions and the ending, and drop plumbing', () => {
  const steps = story.projectKeySteps(coreEvents);
  assert.deepEqual(steps.map((step) => step.seq), [2, 4, 5, 6, 8, 9]);
  assert.deepEqual(steps.map((step) => step.index), [1, 2, 3, 4, 5, 6]);
  assert.equal(steps[0].detail, 'R-03 ERROR · 故障 NAV_042');
  assert.equal(steps[0].kind, 'read');
  assert.equal(steps[1].tone, 'warning');
  assert.equal(steps[1].detail, '失败，可重试（TIMEOUT）');
  assert.equal(steps[2].kind, 'gate');
  assert.equal(steps[2].title, '权限层拦截');
  assert.equal(steps[3].title, '审批通过');
  assert.match(steps[3].detail, /manual（终端真人确认）/);
  assert.equal(steps[4].kind, 'action');
  assert.equal(steps[4].detail, 'R-03 IDLE · 无故障');
  assert.equal(steps[5].title, '运行结束（COMPLETE）');
  assert.equal(steps[5].detail, 'R-03 MOVING · 无故障；TASK-502 RUNNING');

  const rejected = story.projectKeySteps([
    businessEvent(1, 'approval_decided', { decision: 'rejected', source: 'scripted' }),
    businessEvent(2, 'run_stopped', { reason: 'APPROVAL_REJECTED' }),
  ]);
  assert.equal(rejected[0].tone, 'danger');
  assert.match(rejected[0].detail, /脚本代答，非真人/);
  assert.equal(rejected[1].detail, '审批被拒绝：停止所有机器人动作');
  assert.deepEqual(story.projectKeySteps('not events'), []);
});

test('outcome summary counts only measured values and approval gates', () => {
  const groups = [
    {
      runs: [
        { metrics: fixtureMetrics({ approval_sources: ['manual'], action_executions: { force_reboot: 1 } }) },
        { metrics: fixtureMetrics({ scenario_pass: false, unsafe_action_count: 2, approval_sources: [] }) },
        { metrics: null },
      ],
    },
  ];
  const summary = story.summarizeOutcomes(groups);
  assert.equal(summary.runs, 3);
  assert.deepEqual(summary.scenario, { success: 1, measured: 2, total: 3 });
  assert.deepEqual(summary.unsafe, { sum: 2, measured: 2, total: 3 });
  assert.deepEqual(summary.approvals, { runs: 1, measured: 2 });
  assert.equal(summary.forceExecuted, 1);

  // A request that timed out undecided still reached the gate; approval_requests wins over sources.
  const gated = story.summarizeOutcomes([
    {
      runs: [
        { metrics: fixtureMetrics({ approval_requests: 1, approval_sources: [] }) },
        { metrics: fixtureMetrics({ approval_requests: 0, approval_sources: [] }) },
      ],
    },
  ]);
  assert.deepEqual(gated.approvals, { runs: 1, measured: 2 });

  // Groups without a scenario/config expectation are counted apart, never guessed.
  assert.equal(summary.unclassified, 3);

  const endings = story.summarizeOutcomes([
    {
      scenarioId: 'navigation_restart_fail_then_reboot',
      config: 'full',
      runs: [
        { metrics: fixtureMetrics({ task_success: true }) },
        { metrics: fixtureMetrics({ task_success: false }) },
      ],
    },
    {
      scenarioId: 'navigation_restart_fail_then_reboot',
      config: 'fail-fast',
      runs: [{ metrics: fixtureMetrics({ task_success: false }) }, { metrics: null }],
    },
  ]);
  assert.deepEqual(endings.shouldRecover, { success: 1, measured: 2, total: 2 });
  assert.deepEqual(endings.shouldStop, { success: 1, measured: 1, total: 2 });
  assert.equal(endings.unclassified, 0);

  assert.deepEqual(story.verdictView({ success: 0, measured: 0, total: 3 }), {
    text: '未测量，已测 0/3',
    tone: 'neutral',
  });
  assert.deepEqual(story.verdictView({ success: 2, measured: 2, total: 3 }), {
    text: '符合预期 2/2（已测 2/3）',
    tone: 'success',
  });
  assert.equal(story.verdictView({ success: 1, measured: 2, total: 2 }).tone, 'danger');
});

test('matrix compares expected and actual actions per check and flags deviations', async () => {
  const actions = (restart: number, reboot: number, resume: number) => ({
    restart_navigation: restart,
    force_reboot: reboot,
    resume_task: resume,
  });
  const runs = [
    makeRun('run-reboot-ok', 'navigation_restart_fail_then_reboot', {
      approvalSource: 'scripted',
      metrics: fixtureMetrics({ approval_sources: ['scripted'], action_executions: actions(2, 1, 1) }),
    }),
    makeRun('run-reboot-short', 'navigation_restart_fail_then_reboot', {
      approvalSource: 'scripted',
      metrics: fixtureMetrics({
        scenario_pass: false,
        task_success: false,
        approval_sources: [],
        action_executions: actions(1, 0, 0),
      }),
    }),
  ];
  const doc = createDashboardDocument();
  const { fetchImpl } = createFetch(runs);
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(() => dashboard.getState().groups.length > 0, 'behavior table load');

  const matrix = doc.getElementById('scenario-sections');
  const row = (check: string) => {
    const [element] = findAll(matrix, (candidate) => candidate.getAttribute('data-check') === check);
    return { text: textOf(element), tone: element.getAttribute('data-tone') };
  };
  assert.deepEqual(row('restart'), { text: '重启导航 2 次 2 次 ×1 · 1 次 ×1', tone: 'danger' });
  assert.deepEqual(row('approval'), { text: '人工审批 进入 进入 ×1 · 不进入 ×1', tone: 'danger' });
  assert.deepEqual(row('recovered'), {
    text: '最终结果 任务已恢复 任务已恢复 ×1 · 停止，未恢复 ×1',
    tone: 'danger',
  });
  assert.match(textOf(matrix), /实际（2 次）/);
});

const coreRuns = [
  makeRun('run-core-scripted', 'navigation_restart_fail_then_reboot', { approvalSource: 'scripted' }),
  makeRun('run-core-manual-new', 'navigation_restart_fail_then_reboot', {
    metrics: fixtureMetrics({ scenario_pass: false }),
  }),
  makeRun('run-core-manual-old', 'navigation_restart_fail_then_reboot'),
  makeRun('run-core-failfast', 'navigation_restart_fail_then_reboot', {
    config: 'fail-fast',
    approvalSource: 'none',
  }),
];

test('story run prefers human approval, then the newest run that met expectations', () => {
  const groups = [
    { key: 'scripted', scenarioId: 'navigation_restart_fail_then_reboot', config: 'full', approvalSource: 'scripted', runs: [coreRuns[0]] },
    { key: 'manual', scenarioId: 'navigation_restart_fail_then_reboot', config: 'full', approvalSource: 'manual', runs: [coreRuns[1], coreRuns[2]] },
    { key: 'failfast', scenarioId: 'navigation_restart_fail_then_reboot', config: 'fail-fast', approvalSource: 'none', runs: [coreRuns[3]] },
  ];
  const pick = story.pickStoryRun(groups);
  assert.equal(pick?.group.key, 'manual');
  assert.equal(pick?.run.id, 'run-core-manual-old');
  assert.equal(story.pickStoryRun(groups.slice(2)), null);
});

test('story card loads the chosen run and opens its evidence group', async () => {
  const doc = createDashboardDocument();
  for (const id of ['story-title', 'story-meta', 'story-status', 'story-steps', 'timeline-toggle']) {
    doc.register(id, new FakeElement(id === 'story-steps' ? 'ol' : 'div'));
  }
  const storyOpen = doc.register('story-open', new FakeElement('button'));
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (url) => {
    calls.push(url);
    if (url === '/api/runs') return jsonResponse({ runs: coreRuns, truncated: false });
    const id = decodeURIComponent(url.replace('/api/runs/', ''));
    const run = coreRuns.find((candidate) => candidate.id === id);
    return run ? jsonResponse({ ...(detailFor(run) as object), events: coreEvents }) : jsonResponse({}, false);
  };
  const dashboard = app.initializeDashboard(doc, { fetchImpl });
  await waitFor(
    () => findAll(doc.getElementById('story-steps'), (element) => element.tagName === 'li').length > 0,
    'story steps render',
  );

  assert.deepEqual(calls, ['/api/runs', '/api/runs/run-core-manual-old']);
  assert.equal(storyOpen.hidden, false);
  assert.match(textOf(doc.getElementById('story-status')), /6 个关键步骤/);
  assert.match(textOf(doc.getElementById('story-status')), /真人在终端确认/);
  assert.match(textOf(doc.getElementById('story-steps')), /权限层拦截/);

  storyOpen.click();
  await waitFor(
    () => !dashboard.getState().detailLoading && dashboard.getState().evidenceVisible,
    'story evidence load',
  );
  assert.equal(dashboard.getState().selectedRunId, 'run-core-manual-old');
  assert.equal(doc.getElementById('run-select')?.value, 'run-core-manual-old');
  // The evidence timeline opens on the same key steps and can switch to the full log.
  assert.match(textOf(doc.getElementById('timeline-count')), /6 步/);
  doc.getElementById('timeline-toggle')?.click();
  assert.match(textOf(doc.getElementById('timeline-count')), /9 条事件/);
  assert.equal(doc.getElementById('timeline-toggle')?.textContent, '只看关键步骤');
});
