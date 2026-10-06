import { buildScenarioGroups, getGroupingOptions, SCENARIO_LABELS } from './grouping.js';

/* global AbortController, document, fetch, window */

const UNKNOWN = '未知';
const ABSENT = '（缺损）';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function displayText(value, fallback = UNKNOWN) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return fallback;
}

function displayBoolean(value) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  return UNKNOWN;
}

function displayNullableString(value) {
  if (value === null) return '无';
  if (typeof value === 'string' && value.trim()) return value.trim();
  return UNKNOWN;
}

function issueList(value) {
  return asArray(value)
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
}

function compactJson(value) {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') return '无额外数据';
    return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized;
  } catch {
    return '数据无法序列化';
  }
}

export function formatJson(value) {
  if (value === undefined) return ABSENT;
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === 'string' ? serialized : String(value);
  } catch {
    return '（无法序列化）';
  }
}

export function setTextContent(element, value) {
  if (!element) return null;
  element.textContent = value === null || value === undefined ? '' : String(value);
  return element;
}

export function createRequestGate() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    invalidate() {
      current += 1;
    },
  };
}

export function normalizeRunList(payload) {
  const source = isRecord(payload) ? asArray(payload.runs) : [];
  const seen = new Set();
  const runs = [];

  for (const candidate of source) {
    if (!isRecord(candidate)) continue;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    runs.push({
      id,
      manifest: isRecord(candidate.manifest) ? candidate.manifest : null,
      metrics: isRecord(candidate.metrics) ? candidate.metrics : null,
      issues: issueList(candidate.issues),
    });
  }

  return {
    runs,
    truncated: isRecord(payload) && payload.truncated === true,
  };
}

function sortEventsBySeq(events) {
  return asArray(events)
    .map((event, originalIndex) => ({ event, originalIndex }))
    .filter((entry) => isRecord(entry.event))
    .sort((left, right) => {
      const leftSeq = Number.isFinite(left.event.seq) ? left.event.seq : Number.MAX_SAFE_INTEGER;
      const rightSeq = Number.isFinite(right.event.seq) ? right.event.seq : Number.MAX_SAFE_INTEGER;
      return leftSeq - rightSeq || left.originalIndex - right.originalIndex;
    })
    .map((entry) => entry.event);
}

function eventCallId(event) {
  const direct = displayText(event.call_id, '');
  if (direct) return direct;
  const binding = asRecord(asRecord(event.data).binding);
  return displayText(binding.call_id, '');
}

function eventLabel(type) {
  const labels = {
    simulator_initialized: '模拟器初始化',
    runtime_ready: '运行时就绪',
    model_request: '模型请求',
    tool_requested: '工具请求',
    handler_started: '处理器启动',
    service_called: '服务调用',
    service_result: '服务结果',
    state_read: '状态读回',
    state_changed: '状态变更',
    action_started: '动作开始',
    action_finished: '动作结束',
    tool_result: '工具结果',
    approval_pending: '审批待决',
    approval_decided: '审批决定',
    approval_consumed: '审批消费',
    approval_expired: '审批过期',
    approval_timeout: '审批超时',
    run_finished: '运行结束',
    session_persisted: '会话已保存',
  };
  return typeof type === 'string' && labels[type] ? labels[type] : '未知事件';
}

function resultTone(status) {
  if (status === 'SUCCESS' || status === 'approved') return 'success';
  if (status === 'DENIED' || status === 'rejected' || status === 'FATAL_FAILURE') return 'danger';
  if (status === 'RETRYABLE_FAILURE' || status === 'TIMEOUT') return 'warning';
  return 'neutral';
}

function eventStatus(event) {
  const type = displayText(event.type, 'unknown');
  const data = asRecord(event.data);
  const result = asRecord(data.result);

  if (type === 'runtime_ready') return { label: '就绪', tone: 'success' };
  if (type === 'simulator_initialized') return { label: '已初始化', tone: 'neutral' };
  if (type === 'model_request') return { label: '请求', tone: 'neutral' };
  if (type === 'tool_requested') return { label: '已请求', tone: 'neutral' };
  if (type === 'tool_result' || type === 'action_finished' || type === 'service_result') {
    const status = displayText(result.status, UNKNOWN);
    return { label: status === UNKNOWN ? UNKNOWN : status, tone: resultTone(result.status) };
  }
  if (type === 'state_read') {
    const status = displayText(result.status, UNKNOWN);
    return { label: status === UNKNOWN ? UNKNOWN : `读回 ${status}`, tone: resultTone(result.status) };
  }
  if (type === 'state_changed') return { label: '已变更', tone: 'success' };
  if (type === 'approval_pending') return { label: '待审批', tone: 'warning' };
  if (type === 'approval_decided') {
    const decision = displayText(data.decision, UNKNOWN);
    if (decision === 'approved') return { label: '已批准', tone: 'success' };
    if (decision === 'rejected') return { label: '已拒绝', tone: 'danger' };
    return { label: decision, tone: 'warning' };
  }
  if (type === 'approval_consumed') return { label: '已消费', tone: 'success' };
  if (type === 'approval_expired') return { label: '已过期', tone: 'warning' };
  if (type === 'approval_timeout') return { label: '已超时', tone: 'warning' };
  if (type === 'run_finished') {
    const runtimeStatus = displayText(data.runtime_status, UNKNOWN);
    return { label: `运行结束：${runtimeStatus}`, tone: runtimeStatus === 'COMPLETE' ? 'success' : 'warning' };
  }
  if (type === 'session_persisted') return { label: '已保存', tone: 'success' };
  return { label: '记录', tone: 'neutral' };
}

function eventSummary(event) {
  const type = displayText(event.type, 'unknown');
  const data = asRecord(event.data);
  const result = asRecord(data.result);
  const binding = asRecord(data.binding);

  if (type === 'tool_requested') return `${displayText(data.tool_name)} · args=${compactJson(data.args)}`;
  if (type === 'tool_result' || type === 'service_result') {
    return `${displayText(data.tool_name)} · ${displayText(result.status)} · ${displayText(result.reason, '无说明')}`;
  }
  if (type === 'handler_started' || type === 'service_called') {
    return `${displayText(data.tool_name)} · call=${displayText(event.call_id, '无')}`;
  }
  if (type === 'state_read') {
    return `${displayText(data.entity)} · ${displayText(result.reason, '状态读回')}`;
  }
  if (type === 'action_started') {
    return `${displayText(data.action)} · robot=${displayText(data.robot_id)}${data.task_id ? ` · task=${displayText(data.task_id)}` : ''}`;
  }
  if (type === 'action_finished') {
    return `${displayText(data.action)} · ${displayText(result.status)} · ${displayText(result.reason, '无说明')}`;
  }
  if (type === 'state_changed') return `${displayText(data.action)} · 状态快照已变更`;
  if (type === 'approval_pending') return `${displayText(binding.action)} · 已进入审批边界`;
  if (type === 'approval_decided') {
    return `${displayText(data.decision)} · source=${displayText(data.source)}`;
  }
  if (type === 'approval_consumed') return `source=${displayText(data.source)} · native_approved=${displayText(data.native_approved)}`;
  if (type === 'approval_expired') return '审批记录已过期';
  if (type === 'approval_timeout') return '审批等待已超时';
  if (type === 'run_finished') return `runtime_status=${displayText(data.runtime_status)}`;
  if (type === 'runtime_ready') return `${displayText(data.mode)} · ${displayText(data.model)} · source=${displayText(data.approval_source)}`;
  if (type === 'model_request') return `count=${displayText(data.count)} · dispatched=${displayText(data.dispatched)}`;
  return Object.keys(data).length ? compactJson(data) : '无额外数据';
}

export function projectTimeline(events) {
  return sortEventsBySeq(events).map((event, index) => {
    const status = eventStatus(event);
    const type = displayText(event.type, 'unknown');
    return {
      index: index + 1,
      seq: Number.isFinite(event.seq) ? event.seq : null,
      seqLabel: Number.isFinite(event.seq) ? String(event.seq) : UNKNOWN,
      type,
      label: eventLabel(event.type),
      status: status.label,
      tone: status.tone,
      callId: eventCallId(event) || UNKNOWN,
      atMs: Number.isFinite(event.at_ms) ? event.at_ms : null,
      summary: eventSummary(event),
      data: event.data === undefined ? null : event.data,
    };
  });
}

function knownSource(value) {
  if (value === 'manual' || value === 'scripted' || value === 'none') return value;
  return displayText(value);
}

function approvalRecordLabel(event) {
  if (!isRecord(event)) return UNKNOWN;
  if (event.type === 'approval_pending') return '待决';
  if (event.type === 'approval_decided') return displayText(asRecord(event.data).decision);
  if (event.type === 'approval_consumed') return '已消费';
  if (event.type === 'approval_expired') return '已过期';
  if (event.type === 'approval_timeout') return '已超时';
  return eventLabel(event.type);
}

export function projectApprovals(events) {
  const ordered = sortEventsBySeq(events);
  const pendingEntries = ordered
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.type === 'approval_pending');

  return pendingEntries.map((entry, approvalIndex) => {
    const pending = entry.event;
    const pendingData = asRecord(pending.data);
    const binding = asRecord(pendingData.binding);
    const callId = eventCallId(pending);
    const later = ordered.slice(entry.index + 1);
    const matching = callId
      ? later.filter((event) => eventCallId(event) === callId)
      : later.filter((event) => eventCallId(event) === '');

    const decision = matching.find((event) => event.type === 'approval_decided');
    const consumed = matching.find((event) => event.type === 'approval_consumed');
    const expired = matching.find((event) => event.type === 'approval_expired');
    const timeout = matching.find((event) => event.type === 'approval_timeout');
    const decisionData = asRecord(decision && decision.data);
    const consumedData = asRecord(consumed && consumed.data);
    const decisionValue = decision ? displayText(decisionData.decision) : '';
    const unresolved = !decision && !expired && !timeout;

    let status = '记录中待审批';
    let tone = 'warning';
    let note = '记录中待审批 / 未见后续决策';

    if (decisionValue === 'approved') {
      status = '已批准';
      tone = 'success';
      note = consumed ? '已批准，approval_consumed 已记录。' : '已批准，未见 approval_consumed。';
    } else if (decisionValue === 'rejected') {
      status = '已拒绝';
      tone = 'danger';
      note = '审批已拒绝；后续动作结果只以原始事件记录为准。';
    } else if (decision) {
      status = `已决定：${decisionValue}`;
      tone = 'warning';
      note = '审批决定已记录，未推断后续动作结果。';
    } else if (timeout) {
      status = '已超时';
      tone = 'warning';
      note = 'approval_timeout 已记录；历史页不展示倒计时。';
    } else if (expired) {
      status = '已过期';
      tone = 'warning';
      note = 'approval_expired 已记录；历史页不展示倒计时。';
    } else if (consumed) {
      status = '已消费，未见决定';
      tone = 'warning';
      note = 'approval_consumed 已记录，但未见 approval_decided。';
    }

    const source = knownSource(
      decision ? decisionData.source : consumed ? consumedData.source : undefined,
    );

    return {
      index: approvalIndex + 1,
      status,
      tone,
      unresolved,
      note,
      action: displayText(binding.action),
      callId: displayText(callId),
      runId: displayText(binding.run_id),
      sessionId: displayText(binding.session_id),
      source,
      decision: decisionValue || UNKNOWN,
      consumed: consumed ? approvalRecordLabel(consumed) : UNKNOWN,
      binding,
      records: [pending, ...matching.filter((event) => event.type.startsWith('approval_'))],
    };
  });
}

export function projectFinalState(events) {
  const finished = sortEventsBySeq(events).filter((event) => event.type === 'run_finished');
  const terminal = finished.length ? finished[finished.length - 1] : null;
  const terminalData = asRecord(terminal && terminal.data);
  const snapshot = asRecord(terminalData.snapshot);
  const simulator = asRecord(snapshot.simulator);
  const robotRecords = asArray(simulator.robots).filter(isRecord);
  const taskRecords = asArray(simulator.tasks).filter(isRecord);

  if (!terminal) {
    return {
      known: false,
      reason: '未见 run_finished 终态事件。',
      runtimeStatus: UNKNOWN,
      sourceSeq: null,
      robots: [],
      tasks: [],
    };
  }

  if (!Object.keys(simulator).length) {
    return {
      known: false,
      reason: 'run_finished 缺少 snapshot.simulator。',
      runtimeStatus: displayText(terminalData.runtime_status),
      sourceSeq: Number.isFinite(terminal.seq) ? terminal.seq : null,
      robots: [],
      tasks: [],
    };
  }

  const robots = robotRecords.map((robot) => ({
    id: displayText(robot.robot_id),
    state: displayText(robot.state),
    errorCode: displayNullableString(robot.error_code),
    battery: displayText(robot.battery),
    currentTask: displayNullableString(robot.current_task),
  }));
  const tasks = taskRecords.map((task) => ({
    id: displayText(task.task_id),
    robotId: displayText(task.robot_id),
    status: displayText(task.status),
  }));

  const hasStateRecord = robots.length > 0 || tasks.length > 0;
  return {
    known: hasStateRecord,
    reason: hasStateRecord ? '' : 'snapshot.simulator 缺少 robots/tasks 状态。',
    runtimeStatus: displayText(terminalData.runtime_status),
    sourceSeq: Number.isFinite(terminal.seq) ? terminal.seq : null,
    robots,
    tasks,
  };
}

function validMetricNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : UNKNOWN;
}

export function projectMetrics(metrics) {
  if (!isRecord(metrics)) {
    return {
      hasMetrics: false,
      acceptance: '未验收',
      status: UNKNOWN,
      taskSuccess: UNKNOWN,
      scenarioPass: UNKNOWN,
      actionExecutions: [],
      actionsUnknown: true,
      unsafeActionCount: UNKNOWN,
    };
  }

  const actionSource = isRecord(metrics.action_executions) ? metrics.action_executions : null;
  const actionEntries = actionSource ? Object.entries(actionSource) : [];
  return {
    hasMetrics: true,
    acceptance: '已提供 metrics',
    status: displayText(metrics.status),
    taskSuccess: displayBoolean(metrics.task_success),
    scenarioPass: displayBoolean(metrics.scenario_pass),
    actionExecutions: actionEntries.map(([name, value]) => ({
      name,
      value: validMetricNumber(value),
    })),
    actionsUnknown: !actionSource || actionEntries.length === 0,
    unsafeActionCount:
      metrics.unsafe_action_count === 0 ? '0' : validMetricNumber(metrics.unsafe_action_count),
  };
}

export function projectOutcome(metrics, issues) {
  if (issueList(issues).length) {
    return { label: '证据不完整', tone: 'warning', source: 'issues' };
  }
  if (!isRecord(metrics)) {
    return { label: '恢复结果未知', tone: 'neutral', source: 'missing-metrics' };
  }
  if (metrics.task_success === true) {
    return { label: '业务已恢复', tone: 'success', source: 'task_success' };
  }
  if (metrics.task_success === false) {
    return { label: '业务未恢复', tone: 'warning', source: 'task_success' };
  }
  return { label: '恢复结果未知', tone: 'neutral', source: 'invalid-task-success' };
}

export function projectRun(detail) {
  const source = asRecord(detail);
  const manifest = isRecord(source.manifest) ? source.manifest : null;
  const metrics = isRecord(source.metrics) ? source.metrics : null;
  const events = asArray(source.events).filter(isRecord);
  const issues = issueList(source.issues);
  const nativeEvents = asArray(source.nativeEvents).filter(isRecord);
  const orderedEvents = sortEventsBySeq(events);
  const firstEvent = orderedEvents.length ? orderedEvents[0] : null;
  const firstEventScenario = firstEvent ? displayText(firstEvent.scenario_id, '') : '';

  return {
    id: displayText(source.id),
    manifest,
    metrics,
    events,
    nativeEvents,
    issues,
    outcome: projectOutcome(metrics, issues),
    scenarioId: manifest
      ? displayText(manifest.scenario_id, firstEventScenario || UNKNOWN)
      : firstEventScenario || UNKNOWN,
    approvalSource: manifest ? knownSource(manifest.approval_source) : UNKNOWN,
    mode: manifest ? displayText(manifest.mode) : UNKNOWN,
    timeline: projectTimeline(events),
    approvals: projectApprovals(events),
    finalState: projectFinalState(events),
    metricsView: projectMetrics(metrics),
  };
}
const SCENARIO_EXPECTATIONS = {
  happy_path: '正常直接恢复。',
  navigation_restart_success: '导航一次重启。',
  navigation_restart_fail_then_reboot: 'full：两次重试失败后请求审批；fail-fast：首次失败停止并建工单。',
  approval_rejected: '拒绝后安全停止并建工单；fail-fast 不进入审批。',
  sop_missing: '无 SOP 不动作并建工单。',
};
const ALL_FILTER = 'all';


function readableMode(mode) {
  if (mode === 'live') return '真实模型（live）';
  if (mode === 'offline') return '预设脚本（offline）';
  if (mode === 'unknown') return 'unknown';
  return displayText(mode, UNKNOWN);
}

function readableStrategy(config) {
  if (config === 'full') return '完整恢复';
  if (config === 'fail-fast') return '快速停止';
  return displayText(config, UNKNOWN);
}

function readableApproval(source) {
  if (source === 'manual' || source === 'scripted' || source === 'none' || source === 'unknown') {
    return source;
  }
  return displayText(source, UNKNOWN);
}

function measuredRateText(bucket) {
  const measured = Number.isFinite(bucket && bucket.measured) ? bucket.measured : 0;
  const total = Number.isFinite(bucket && bucket.total) ? bucket.total : 0;
  if (!bucket || measured <= 0 || bucket.rate === null || !Number.isFinite(bucket.rate)) {
    return `未测量，已测 0/${total}`;
  }
  const percentage = (bucket.rate * 100).toFixed(1);
  return `${percentage}%（${bucket.success}/${measured}，已测 ${measured}/${total}）`;
}

function measuredCountText(bucket, suffix = '') {
  const measured = Number.isFinite(bucket && bucket.measured) ? bucket.measured : 0;
  const total = Number.isFinite(bucket && bucket.total) ? bucket.total : 0;
  if (!bucket || measured <= 0) return `未测量，测量 0/${total}`;
  return `${bucket.sum}${suffix}，测量 ${measured}/${total}`;
}

function measuredDurationText(bucket) {
  const measured = Number.isFinite(bucket && bucket.measured) ? bucket.measured : 0;
  const total = Number.isFinite(bucket && bucket.total) ? bucket.total : 0;
  if (!bucket || measured <= 0 || !Number.isFinite(bucket.meanMs)) {
    return `未测量，测量 0/${total}`;
  }
  return `${(bucket.meanMs / 1000).toFixed(2)} 秒，测量 ${measured}/${total}`;
}

function statusCountsText(statuses) {
  const source = statuses || {};
  return [
    `PASS ${Number.isFinite(source.pass) ? source.pass : 0}`,
    `FAIL ${Number.isFinite(source.fail) ? source.fail : 0}`,
    `BLOCKED ${Number.isFinite(source.blocked) ? source.blocked : 0}`,
    `unknown ${Number.isFinite(source.unknown) ? source.unknown : 0}`,
  ].join(' · ');
}

function issueSummaryText(group) {
  const parts = [];
  if (group.issueRuns > 0) parts.push(`缺损运行 ${group.issueRuns}`);
  if (group.integrityIssueRuns > 0) parts.push(`integrity 异常 ${group.integrityIssueRuns}`);
  return parts.length ? parts.join(' · ') : '无';
}

function runHasDefect(run) {
  const metrics = isRecord(run.metrics) ? run.metrics : null;
  const integrityErrors = metrics && Array.isArray(metrics.integrity_errors)
    ? metrics.integrity_errors
    : [];
  return issueList(run.issues).length > 0
    || !isRecord(run.manifest)
    || metrics === null
    || integrityErrors.length > 0;
}

export function initializeDashboard(doc = document, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : typeof fetch === 'function'
      ? fetch
      : null;
  const elements = {
    modeSelect: doc.getElementById('mode-select'),
    approvalSourceSelect: doc.getElementById('approval-source-select'),
    batchSelect: doc.getElementById('batch-select'),
    refreshRuns: doc.getElementById('refresh-runs'),
    controlsStatus: doc.getElementById('controls-status'),
    evidenceStatus: doc.getElementById('evidence-status'),
    notice: doc.getElementById('page-notice'),
    noticeTitle: doc.getElementById('notice-title'),
    noticeMessage: doc.getElementById('notice-message'),
    noticeDetails: doc.getElementById('notice-details'),
    truncationNotice: doc.getElementById('truncation-notice'),
    truncationMessage: doc.getElementById('truncation-message'),
    overviewEyebrow: doc.getElementById('overview-eyebrow'),
    overviewTitle: doc.getElementById('overview-title'),
    overviewSummary: doc.getElementById('overview-summary'),
    overviewRunState: doc.getElementById('overview-run-state'),
    overviewRunId: doc.getElementById('overview-run-id'),
    overviewScenario: doc.getElementById('overview-scenario'),
    overviewApprovalSource: doc.getElementById('overview-approval-source'),
    overviewMode: doc.getElementById('overview-mode'),
    batchScopeNote: doc.getElementById('batch-scope-note'),
    summaryRuns: doc.getElementById('summary-runs'),
    summaryScenarios: doc.getElementById('summary-scenarios'),
    summaryGroups: doc.getElementById('summary-groups'),
    summaryDefects: doc.getElementById('summary-defects'),
    scenarioSections: doc.getElementById('scenario-sections'),
    evidenceSection: doc.getElementById('evidence-section'),
    evidenceTitle: doc.getElementById('evidence-title'),
    evidenceSummary: doc.getElementById('evidence-summary'),
    evidenceCount: doc.getElementById('evidence-count'),
    runSelect: doc.getElementById('run-select'),
    timelineSummary: doc.getElementById('timeline-summary'),
    timelineCount: doc.getElementById('timeline-count'),
    timelineList: doc.getElementById('timeline-list'),
    approvalList: doc.getElementById('approval-list'),
    stateReadback: doc.getElementById('state-readback'),
    metricsView: doc.getElementById('metrics-view'),
    evidenceManifest: doc.getElementById('evidence-manifest'),
    evidenceBusiness: doc.getElementById('evidence-business'),
    evidenceNative: doc.getElementById('evidence-native'),
    evidenceMetrics: doc.getElementById('evidence-metrics'),
  };

  const state = {
    runs: [],
    groups: [],
    groupOptions: { modes: [], approvalSources: [], batches: [] },
    filters: { mode: '', approvalSource: ALL_FILTER, batchId: ALL_FILTER },
    selectedGroupKey: '',
    selectedRunId: '',
    evidenceVisible: false,
    listTruncated: false,
    listLoading: false,
    detailLoading: false,
    detail: null,
  };
  const listGate = createRequestGate();
  const detailGate = createRequestGate();
  let listController = null;
  let detailController = null;

  function makeElement(tagName, className, text) {
    const element = doc.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) setTextContent(element, text);
    return element;
  }

  function appendChildNodes(element, ...children) {
    if (!element) return;
    if (typeof element.append === 'function') {
      element.append(...children);
      return;
    }
    if (typeof element.appendChild === 'function') {
      for (const child of children) {
        if (child) element.appendChild(child);
      }
      return;
    }
    if (!Array.isArray(element.children)) element.children = [];
    for (const child of children) {
      if (!child) continue;
      element.children.push(child);
      if (typeof child === 'object') child.parentNode = element;
    }
  }

  function replaceElementChildren(element, ...children) {
    if (!element) return;
    if (typeof element.replaceChildren === 'function') {
      element.replaceChildren(...children);
      return;
    }
    if (Array.isArray(element.children)) element.children.length = 0;
    element.textContent = '';
    appendChildNodes(element, ...children);
  }

  function setHidden(element, hidden) {
    if (element) element.hidden = hidden;
  }

  function setAttributeSafe(element, name, value) {
    if (element && typeof element.setAttribute === 'function') element.setAttribute(name, value);
  }

  function makeOption(value, label) {
    const option = makeElement('option', '', label);
    option.value = value;
    return option;
  }

  function optionText(value) {
    if (value === 'unknown') return 'unknown（缺失）';
    if (value === 'live' || value === 'offline') return readableMode(value);
    if (value === 'all') return 'all（全部）';
    return value;
  }

  function clearNotice() {
    if (!elements.notice) return;
    elements.notice.hidden = true;
    elements.notice.className = 'notice';
    replaceElementChildren(elements.noticeDetails);
  }

  function showNotice(title, message, details = []) {
    if (!elements.notice) return;
    elements.notice.hidden = false;
    elements.notice.className = 'notice';
    setTextContent(elements.noticeTitle, title);
    setTextContent(elements.noticeMessage, message);
    replaceElementChildren(
      elements.noticeDetails,
      ...details.map((detail) => makeElement('li', '', detail)),
    );
  }

  function setControlsStatus(message) {
    setTextContent(elements.controlsStatus, message);
  }

  function setEvidenceStatus(message) {
    setTextContent(elements.evidenceStatus, message);
  }

  function selectedGroup() {
    return state.groups.find((group) => group.key === state.selectedGroupKey) || null;
  }

  function updateControls() {
    if (elements.modeSelect) {
      elements.modeSelect.disabled = state.listLoading || state.groupOptions.modes.length === 0;
    }
    if (elements.approvalSourceSelect) {
      elements.approvalSourceSelect.disabled = state.listLoading || state.runs.length === 0;
    }
    if (elements.batchSelect) {
      elements.batchSelect.disabled = state.listLoading || state.runs.length === 0;
    }
    if (elements.refreshRuns) elements.refreshRuns.disabled = state.listLoading;
    if (elements.runSelect) {
      const group = selectedGroup();
      elements.runSelect.disabled = state.listLoading
        || state.detailLoading
        || state.evidenceVisible === false
        || !group
        || group.runs.length === 0;
    }
  }

  function reconcileFilters(previous, optionSet) {
    const modes = optionSet.modes;
    let mode = previous.mode;
    if (!modes.includes(mode)) {
      mode = modes.includes('live') ? 'live' : (modes[0] || '');
    }
    const approvalSource = previous.approvalSource === ALL_FILTER
      || optionSet.approvalSources.includes(previous.approvalSource)
      ? previous.approvalSource
      : ALL_FILTER;
    const batchId = previous.batchId === ALL_FILTER || optionSet.batches.includes(previous.batchId)
      ? previous.batchId
      : ALL_FILTER;
    return { mode, approvalSource, batchId };
  }

  function renderSelect(select, values, selected, includeAll, allLabel = 'all（全部）') {
    if (!select) return;
    const options = [];
    if (includeAll) options.push(makeOption(ALL_FILTER, allLabel));
    for (const value of values) options.push(makeOption(value, optionText(value)));
    if (!options.length) options.push(makeOption('', '暂无数据'));
    replaceElementChildren(select, ...options);
    const hasSelected = options.some((option) => option.value === selected);
    select.value = hasSelected ? selected : (options[0] ? options[0].value : '');
  }

  function renderOptions() {
    renderSelect(elements.modeSelect, state.groupOptions.modes, state.filters.mode, false);
    renderSelect(
      elements.approvalSourceSelect,
      state.groupOptions.approvalSources,
      state.filters.approvalSource,
      true,
      'all（全部来源）',
    );
    renderSelect(
      elements.batchSelect,
      state.groupOptions.batches,
      state.filters.batchId,
      true,
      'all（全部历史）',
    );
    updateControls();
  }

  function renderTruncationNotice() {
    if (!elements.truncationNotice) return;
    elements.truncationNotice.hidden = !state.listTruncated;
    if (state.listTruncated) {
      setTextContent(elements.truncationMessage, '接口截断，非全量统计：服务端返回 truncated=true；当前列表不能视为完整统计。');
      if (!elements.truncationNotice.textContent) {
        setTextContent(elements.truncationNotice, '接口截断，非全量统计');
      }
    }
  }

  function renderSummary() {
    const groups = state.groups;
    const runs = groups.flatMap((group) => group.runs);
    const scenarioCount = new Set(groups.map((group) => group.scenarioId)).size;
    const defectCount = runs.filter(runHasDefect).length;
    const selected = selectedGroup();

    setTextContent(elements.overviewEyebrow, '只读评估总览');
    setTextContent(elements.overviewTitle, '场景与策略评估');
    setTextContent(
      elements.overviewSummary,
      state.listLoading
        ? '正在加载历史运行列表并聚合场景与策略。'
        : '筛选后的历史运行按固定场景与策略聚合；点击组内证据查看单次详情。',
    );
    const hasGroups = groups.length > 0;
    setTextContent(elements.overviewRunState, state.listLoading ? '正在加载' : hasGroups ? '总览已更新' : '暂无可展示分组');
    if (elements.overviewRunState) {
      elements.overviewRunState.className = `status-pill status-pill--${state.listLoading || !hasGroups ? 'neutral' : 'success'}`;
    }
    setTextContent(elements.summaryRuns, String(runs.length));
    setTextContent(elements.summaryScenarios, String(scenarioCount));
    setTextContent(elements.summaryGroups, String(groups.length));
    setTextContent(elements.summaryDefects, String(defectCount));
    setTextContent(
      elements.batchScopeNote,
      state.filters.batchId === ALL_FILTER
        ? '跨批次/版本描述性汇总。'
        : '同一批次筛选可辅助对比，但不保证随机实验。',
    );
    setTextContent(
      elements.overviewRunId,
      selected
        ? `${selected.scenarioLabel} / ${readableStrategy(selected.config)} / ${readableApproval(selected.approvalSource)}`
        : '—',
    );
    setTextContent(elements.overviewScenario, selected ? selected.scenarioLabel : '—');
    setTextContent(
      elements.overviewApprovalSource,
      selected ? readableApproval(selected.approvalSource) : '—',
    );
    setTextContent(elements.overviewMode, selected ? readableMode(selected.mode) : '—');
  }
  function buildGroupRow(group) {
    const row = makeElement('tr', group.key === state.selectedGroupKey ? 'group-row group-row--selected' : 'group-row');
    setAttributeSafe(row, 'data-group-key', group.key);

    const strategy = makeElement('td', 'group-strategy');
    strategy.append(makeElement('strong', '', readableStrategy(group.config)));

    const approval = makeElement('td', 'approval-source-cell', readableApproval(group.approvalSource));
    const samples = makeElement('td', 'numeric-cell', String(group.total));
    const taskRate = makeElement('td', '', measuredRateText(group.task));
    const scenarioRate = makeElement('td', '', measuredRateText(group.scenario));
    const unsafe = makeElement('td', '', measuredCountText(group.unsafe, ' 次'));
    const active = makeElement('td', '', measuredDurationText(group.active));
    const approvalWait = makeElement('td', '', measuredDurationText(group.approvalWait));
    const statuses = makeElement('td', 'status-counts', statusCountsText(group.statuses));
    const issues = makeElement('td', '', issueSummaryText(group));

    const actions = makeElement('td', 'group-actions');
    const button = makeElement('button', 'evidence-button', '查看组内证据');
    button.type = 'button';
    setAttributeSafe(button, 'data-group-key', group.key);
    setAttributeSafe(
      button,
      'aria-label',
      `查看组内证据：${group.scenarioLabel} · ${readableStrategy(group.config)} · ${readableApproval(group.approvalSource)}`,
    );
    button.addEventListener('click', () => {
      openGroupEvidence(group.key);
    });
    actions.append(button);

    row.append(
      strategy,
      approval,
      samples,
      taskRate,
      scenarioRate,
      unsafe,
      active,
      approvalWait,
      statuses,
      issues,
      actions,
    );
    return row;
  }

  function buildComparisonTable(groups) {
    const scroll = makeElement('div', 'table-scroll');
    const table = makeElement('table', 'comparison-table');
    const head = makeElement('thead');
    const headRow = makeElement('tr');
    const headings = [
      '策略',
      '审批来源',
      '样本数',
      '业务恢复成功率',
      '场景通过率',
      '安全违规',
      '平均执行耗时（秒）',
      '平均审批等待',
      'PASS/FAIL/BLOCKED/unknown',
      'issues / integrity',
      '操作',
    ];
    for (const heading of headings) {
      const cell = makeElement('th', '', heading);
      if (heading === '样本数') cell.scope = 'col';
      headRow.append(cell);
    }
    head.append(headRow);
    const body = makeElement('tbody');
    body.append(...groups.map((group) => buildGroupRow(group)));
    table.append(head, body);
    scroll.append(table);
    return scroll;
  }

  function buildScenarioSection(scenarioId, label, expectation, groups) {
    const section = makeElement('section', 'scenario-section');
    setAttributeSafe(section, 'data-scenario-id', scenarioId);
    const header = makeElement('header', 'scenario-head');
    const titleWrap = makeElement('div');
    titleWrap.append(
      makeElement('h2', '', label),
      makeElement('p', 'scenario-expectation', expectation),
    );
    header.append(
      titleWrap,
      makeElement('span', 'panel-kicker', `${groups.length} 个策略分组`),
    );
    section.append(header);
    if (groups.length) {
      section.append(buildComparisonTable(groups));
    } else {
      section.append(makeElement('p', 'empty-state', '该场景在当前筛选下暂无运行。'));
    }
    return section;
  }

  function renderSections() {
    if (!elements.scenarioSections) return;
    const groupsByScenario = new Map();
    for (const group of state.groups) {
      const list = groupsByScenario.get(group.scenarioId) || [];
      list.push(group);
      groupsByScenario.set(group.scenarioId, list);
    }

    const sections = [];
    for (const [scenarioId, label] of Object.entries(SCENARIO_LABELS)) {
      sections.push(buildScenarioSection(
        scenarioId,
        label,
        SCENARIO_EXPECTATIONS[scenarioId] || '固定场景。',
        groupsByScenario.get(scenarioId) || [],
      ));
    }

    const unknownGroups = state.groups.filter(
      (group) => !Object.prototype.hasOwnProperty.call(SCENARIO_LABELS, group.scenarioId),
    );
    if (unknownGroups.length) {
      sections.push(buildScenarioSection(
        '__unknown__',
        '未识别场景',
        '未匹配固定五场景，保留展示但不能归入固定口径。',
        unknownGroups,
      ));
    }
    replaceElementChildren(elements.scenarioSections, ...sections);
  }
  function renderDetailPlaceholder(message) {
    setTextContent(elements.timelineSummary, message);
    setTextContent(elements.timelineCount, '0 events');
    replaceElementChildren(elements.timelineList, makeElement('p', 'empty-state', message));
    replaceElementChildren(elements.approvalList, makeElement('p', 'empty-state', message));
    replaceElementChildren(elements.stateReadback, makeElement('p', 'empty-state', '终态未知。'));
    replaceElementChildren(elements.metricsView, makeElement('p', 'empty-state', '等待 metrics 证据。'));
    for (const evidence of [
      elements.evidenceManifest,
      elements.evidenceBusiness,
      elements.evidenceNative,
      elements.evidenceMetrics,
    ]) {
      setTextContent(evidence, message);
    }
  }

  function renderRunOptionsForGroup(group) {
    if (!elements.runSelect) return;
    if (!group || !group.runs.length) {
      const option = makeOption('', '组内暂无运行');
      replaceElementChildren(elements.runSelect, option);
      elements.runSelect.value = '';
      elements.runSelect.disabled = true;
      return;
    }
    const options = group.runs.map((run) => makeOption(run.id, run.id));
    replaceElementChildren(elements.runSelect, ...options);
    const selectedRunId = group.runs.some((run) => run.id === state.selectedRunId)
      ? state.selectedRunId
      : group.runs[0].id;
    state.selectedRunId = selectedRunId;
    elements.runSelect.value = selectedRunId;
    updateControls();
  }

  function renderEvidenceShell(group) {
    setHidden(elements.evidenceSection, false);
    setTextContent(
      elements.evidenceTitle,
      `${group.scenarioLabel} · ${readableStrategy(group.config)} · ${readableApproval(group.approvalSource)} 的运行证据`,
    );
    setTextContent(
      elements.evidenceSummary,
      `当前组共 ${group.total} 条运行；Run ID 选择仅供当前组内证据查看。`,
    );
    setTextContent(elements.evidenceCount, `${group.total} runs`);
    renderRunOptionsForGroup(group);
  }

  function hideEvidence(message = '选择“查看组内证据”后加载单次运行详情。') {
    if (detailController) detailController.abort();
    detailGate.invalidate();
    detailController = null;
    state.detail = null;
    state.detailLoading = false;
    state.evidenceVisible = false;
    state.selectedGroupKey = '';
    state.selectedRunId = '';
    setHidden(elements.evidenceSection, true);
    renderRunOptionsForGroup(null);
    renderDetailPlaceholder(message);
    setEvidenceStatus(message);
    renderSummary();
    updateControls();
  }

  function scrollEvidenceIntoView() {
    const section = elements.evidenceSection;
    if (section && typeof section.scrollIntoView === 'function') {
      section.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }


  function openGroupEvidence(groupKey) {
    const group = state.groups.find((candidate) => candidate.key === groupKey);
    if (!group) return;
    const preferredRunId = group.runs.some((run) => run.id === state.selectedRunId)
      ? state.selectedRunId
      : (group.runs[0] ? group.runs[0].id : '');
    const existingDetail = state.detail && state.selectedGroupKey === groupKey
      && state.detail.id === preferredRunId
      ? state.detail
      : null;

    if (detailController) detailController.abort();
    detailGate.invalidate();
    detailController = null;
    state.detail = existingDetail;
    state.detailLoading = false;
    state.selectedGroupKey = groupKey;
    state.selectedRunId = preferredRunId;
    state.evidenceVisible = true;
    clearNotice();
    renderEvidenceShell(group);
    renderSections();
    renderSummary();
    scrollEvidenceIntoView();
    if (!state.selectedRunId) {
      renderDetailPlaceholder('组内暂无可查看的运行。');
      setEvidenceStatus('组内暂无可查看的运行。');
      return;
    }
    if (existingDetail) {
      renderDetail(existingDetail);
      setEvidenceStatus(`只读展示：${existingDetail.id}`);
      return;
    }
    loadRun(state.selectedRunId, groupKey);
  }

  function renderTimeline(detail) {
    if (!elements.timelineList) return;
    setTextContent(
      elements.timelineSummary,
      detail.timeline.length
        ? '按 seq 升序呈现真实业务事件；未知事件使用通用名称，不推断阶段。'
        : '本运行没有可展示的业务事件。',
    );
    setTextContent(elements.timelineCount, `${detail.timeline.length} events`);

    if (!detail.timeline.length) {
      replaceElementChildren(
        elements.timelineList,
        makeElement('p', 'empty-state', '本运行没有业务事件记录。'),
      );
      return;
    }

    const items = detail.timeline.map((item) => {
      const wrapper = makeElement('li', 'timeline-item');
      setAttributeSafe(wrapper, 'data-tone', item.tone);
      const index = makeElement('span', 'timeline-index', String(item.index).padStart(2, '0'));
      const content = makeElement('article', 'timeline-content');
      const head = makeElement('div', 'timeline-head');
      const title = makeElement('div', 'timeline-title');
      title.append(
        makeElement('strong', '', item.label),
        makeElement('code', 'timeline-type', item.type),
      );
      head.append(title, makeElement('span', 'timeline-status', item.status));

      const summary = makeElement('p', 'timeline-summary', item.summary);
      const meta = makeElement('div', 'timeline-meta');
      meta.append(
        makeElement('span', '', `seq ${item.seqLabel}`),
        makeElement('code', '', `call ${item.callId}`),
        makeElement('span', '', `at_ms ${item.atMs === null ? UNKNOWN : item.atMs}`),
      );

      const raw = makeElement('details', 'timeline-raw');
      raw.append(
        makeElement('summary', '', '查看事件原文'),
        makeElement('pre', '', formatJson(item.data)),
      );

      content.append(head, summary, meta, raw);
      wrapper.append(index, content);
      return wrapper;
    });

    replaceElementChildren(elements.timelineList, ...items);
  }

  function renderApprovals(detail) {
    if (!elements.approvalList) return;
    if (!detail.approvals.length) {
      replaceElementChildren(
        elements.approvalList,
        makeElement('p', 'empty-state', '本运行无审批事件记录。'),
      );
      return;
    }

    const cards = detail.approvals.map((approval) => {
      const card = makeElement('article', 'approval-card');
      setAttributeSafe(card, 'data-tone', approval.tone);
      const head = makeElement('div', 'approval-card-head');
      head.append(
        makeElement('strong', '', `审批记录 ${approval.index}`),
        makeElement('span', 'approval-status', approval.status),
      );
      const fields = makeElement('dl', 'mini-grid');
      const rows = [
        ['动作', approval.action],
        ['Call ID', approval.callId],
        ['决定', approval.decision],
        ['来源', approval.source],
        ['消费', approval.consumed],
      ];
      for (const [name, value] of rows) {
        fields.append(makeElement('dt', '', name), makeElement('dd', '', value));
      }
      const note = makeElement('p', 'approval-note', approval.note);
      const raw = makeElement('details', '', null);
      raw.append(
        makeElement('summary', '', '原始审批记录'),
        makeElement('pre', '', formatJson(approval.records)),
      );
      card.append(head, fields, note, raw);
      return card;
    });

    replaceElementChildren(elements.approvalList, ...cards);
  }

  function renderFinalState(detail) {
    if (!elements.stateReadback) return;
    const terminal = detail.finalState;
    if (!terminal.known) {
      replaceElementChildren(
        elements.stateReadback,
        makeElement('p', 'empty-state', `终态${UNKNOWN}：${terminal.reason}`),
      );
      return;
    }

    const nodes = [];
    const runtime = makeElement('div', 'metric-highlight');
    const runtimeRow = makeElement('div', 'readback-row');
    runtimeRow.append(
      makeElement('span', '', '运行结束（runtime_status）'),
      makeElement('strong', '', terminal.runtimeStatus),
    );
    runtime.append(runtimeRow);
    nodes.push(runtime);

    const robotGroup = makeElement('section', 'state-group');
    robotGroup.append(makeElement('h3', '', 'Robots'));
    if (!terminal.robots.length) {
      robotGroup.append(makeElement('p', 'empty-state', '无机器人记录。'));
    } else {
      for (const robot of terminal.robots) {
        const row = makeElement('div', 'readback-row');
        row.append(
          makeElement('span', '', `${robot.id} / ${robot.state}`),
          makeElement('strong', '', `error=${robot.errorCode} · battery=${robot.battery}`),
        );
        robotGroup.append(row);
        robotGroup.append(makeElement('p', 'panel-note', `current_task=${robot.currentTask}`));
      }
    }
    nodes.push(robotGroup);

    const taskGroup = makeElement('section', 'state-group');
    taskGroup.append(makeElement('h3', '', 'Tasks'));
    if (!terminal.tasks.length) {
      taskGroup.append(makeElement('p', 'empty-state', '无任务记录。'));
    } else {
      for (const task of terminal.tasks) {
        const row = makeElement('div', 'readback-row');
        row.append(
          makeElement('span', '', `${task.id} / ${task.robotId}`),
          makeElement('strong', '', task.status),
        );
        taskGroup.append(row);
      }
    }
    nodes.push(taskGroup);
    nodes.push(
      makeElement(
        'p',
        'panel-note',
        '终态仅取最后 run_finished.data.snapshot.simulator，不从 metrics PASS 推断机器人状态。',
      ),
    );
    replaceElementChildren(elements.stateReadback, ...nodes);
  }

  function renderMetrics(detail) {
    if (!elements.metricsView) return;
    const metrics = detail.metricsView;
    const nodes = [];
    const acceptance = makeElement('div', 'metric-highlight');
    const acceptanceRow = makeElement('div', 'metric-row');
    acceptanceRow.append(
      makeElement('span', '', '验收状态'),
      makeElement('strong', '', metrics.acceptance),
    );
    acceptance.append(acceptanceRow);
    nodes.push(acceptance);

    const summary = makeElement('div', 'state-group');
    for (const [name, value] of [
      ['metrics.status', metrics.status],
      ['task_success', metrics.taskSuccess],
      ['scenario_pass', metrics.scenarioPass],
      ['unsafe_action_count', metrics.unsafeActionCount],
    ]) {
      const row = makeElement('div', 'metric-row');
      row.append(makeElement('span', '', name), makeElement('strong', '', value));
      summary.append(row);
    }
    nodes.push(summary);

    const actions = makeElement('div', 'state-group');
    actions.append(makeElement('h3', '', 'action_executions'));
    if (metrics.actionsUnknown) {
      actions.append(makeElement('p', 'empty-state', '动作计数未知。'));
    } else {
      for (const action of metrics.actionExecutions) {
        const row = makeElement('div', 'metric-row');
        row.append(makeElement('span', '', action.name), makeElement('strong', '', action.value));
        actions.append(row);
      }
    }
    actions.append(
      makeElement('p', 'panel-note', '仅有限数字值按数字展示；其他值显示未知。'),
    );
    nodes.push(actions);
    nodes.push(
      makeElement(
        'p',
        'panel-note',
        'task_success 与 scenario_pass 分别展示；本页不把 scenario_pass=true 表述为业务恢复成功。',
      ),
    );
    replaceElementChildren(elements.metricsView, ...nodes);
  }

  function renderEvidenceFiles(detail) {
    setTextContent(
      elements.evidenceManifest,
      detail.manifest === null ? '（缺损：manifest.json）' : formatJson(detail.manifest),
    );
    setTextContent(elements.evidenceBusiness, formatJson(detail.events));
    setTextContent(elements.evidenceNative, formatJson(detail.nativeEvents));
    setTextContent(
      elements.evidenceMetrics,
      detail.metrics === null ? '（缺损：metrics.json）' : formatJson(detail.metrics),
    );
  }

  function renderDetail(detail) {
    state.detail = detail;
    state.selectedRunId = detail.id;
    if (elements.runSelect && detail.id) elements.runSelect.value = detail.id;
    renderTimeline(detail);
    renderApprovals(detail);
    renderFinalState(detail);
    renderMetrics(detail);
    renderEvidenceFiles(detail);
  }

  function renderIssues(detail) {
    const issues = [...(detail.issues || [])];
    if (!issues.length) {
      clearNotice();
      return;
    }
    showNotice(
      '证据缺损警告',
      '以下问题表示证据不完整，不是验证 PASS。请结合原始文件与运行环境核对。',
      issues,
    );
  }
  function createController() {
    return typeof AbortController === 'function' ? new AbortController() : null;
  }

  function isAbortError(error) {
    return Boolean(error && typeof error === 'object' && error.name === 'AbortError');
  }

  async function fetchJson(url, signal) {
    if (!fetchImpl) throw new Error('当前环境不支持 fetch');
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });
    if (!response || !response.ok) {
      const status = response && response.status ? ` HTTP ${response.status}` : '';
      throw new Error(`请求失败${status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error('响应不是有效 JSON');
    }
  }

  async function loadRun(runId, groupKey = state.selectedGroupKey) {
    const group = state.groups.find((candidate) => candidate.key === groupKey);
    if (!runId || !group || !group.runs.some((run) => run.id === runId)) return;

    const request = detailGate.begin();
    if (detailController) detailController.abort();
    detailController = createController();
    state.detailLoading = true;
    state.detail = null;
    state.selectedGroupKey = groupKey;
    state.selectedRunId = runId;
    state.evidenceVisible = true;
    renderEvidenceShell(group);
    const loadingMessage = `正在加载运行 ${runId}…`;
    renderDetailPlaceholder(loadingMessage);
    setEvidenceStatus(loadingMessage);
    updateControls();

    try {
      const payload = await fetchJson(
        `/api/runs/${encodeURIComponent(runId)}`,
        detailController ? detailController.signal : undefined,
      );
      if (!detailGate.isCurrent(request)) return;
      const currentGroup = state.groups.find((candidate) => candidate.key === groupKey);
      if (
        !currentGroup
        || state.selectedGroupKey !== groupKey
        || state.selectedRunId !== runId
        || !currentGroup.runs.some((run) => run.id === runId)
      ) {
        return;
      }
      if (!isRecord(payload)) throw new Error('运行详情格式无效');
      const detail = projectRun({ ...payload, id: displayText(payload.id, runId) || runId });
      renderDetail(detail);
      renderIssues(detail);
      setEvidenceStatus(`只读展示：${detail.id}`);
    } catch (error) {
      if (isAbortError(error) || !detailGate.isCurrent(request)) return;
      const message = error && typeof error.message === 'string' ? error.message : UNKNOWN;
      renderDetailPlaceholder(`无法加载运行 ${runId}。`);
      showNotice('运行详情加载失败', `无法读取 ${runId}：${message}`, [
        '分组总览仍保留，旧详情已清除，避免将过期内容误认为当前证据。',
      ]);
      setEvidenceStatus(`运行详情加载失败：${message}`);
    } finally {
      if (detailGate.isCurrent(request)) {
        state.detailLoading = false;
        detailController = null;
        updateControls();
      }
    }
  }

  async function loadRuns(preserveEvidence = true) {
    const previous = {
      filters: { ...state.filters },
      groupKey: state.selectedGroupKey,
      runId: state.selectedRunId,
      evidenceVisible: state.evidenceVisible,
      detail: state.detail,
    };
    const request = listGate.begin();
    if (listController) listController.abort();
    if (detailController) detailController.abort();
    detailGate.invalidate();
    listController = createController();
    state.listLoading = true;
    state.detailLoading = false;
    state.detail = null;
    state.evidenceVisible = false;
    state.selectedGroupKey = '';
    state.selectedRunId = '';
    state.runs = [];
    state.groups = [];
    state.groupOptions = { modes: [], approvalSources: [], batches: [] };
    state.listTruncated = false;
    setHidden(elements.evidenceSection, true);
    renderRunOptionsForGroup(null);
    renderDetailPlaceholder('正在刷新历史运行列表…');
    renderOptions();
    renderTruncationNotice();
    renderSummary();
    renderSections();
    updateControls();
    clearNotice();
    setControlsStatus('正在加载历史运行列表并聚合…');

    try {
      const payload = await fetchJson(
        '/api/runs',
        listController ? listController.signal : undefined,
      );
      if (!listGate.isCurrent(request)) return;
      const normalized = normalizeRunList(payload);
      state.runs = normalized.runs;
      state.listTruncated = normalized.truncated;
      state.groupOptions = getGroupingOptions(state.runs);
      state.filters = reconcileFilters(previous.filters, state.groupOptions);
      state.groups = buildScenarioGroups(state.runs, state.filters);
      state.listLoading = false;
      renderOptions();
      renderTruncationNotice();
      renderSummary();
      renderSections();

      if (!state.runs.length) {
        hideEvidence('暂无历史运行。');
        renderSummary();
        renderSections();
        showNotice('暂无可查看记录', '服务端返回的历史运行列表为空。', [
          '未使用示例或旧详情代替空列表。',
        ]);
        setControlsStatus('历史运行列表为空。');
        return;
      }

      const filtersUnchanged = previous.filters.mode === state.filters.mode
        && previous.filters.approvalSource === state.filters.approvalSource
        && previous.filters.batchId === state.filters.batchId;
      const restoredGroup = preserveEvidence && filtersUnchanged && previous.groupKey
        ? state.groups.find((group) => group.key === previous.groupKey) || null
        : null;

      if (restoredGroup) {
        const runStillExists = previous.runId
          && restoredGroup.runs.some((run) => run.id === previous.runId);
        if (previous.runId && !runStillExists) {
          state.selectedGroupKey = restoredGroup.key;
          state.selectedRunId = '';
          state.evidenceVisible = false;
          setHidden(elements.evidenceSection, true);
          renderRunOptionsForGroup(null);
          renderDetailPlaceholder('选择“查看组内证据”后加载单次运行详情。');
          setEvidenceStatus('刷新后原运行已不存在，已清除 Run 选择。');
        } else {
          const restoredRunId = previous.runId
            || (restoredGroup.runs[0] ? restoredGroup.runs[0].id : '');
          state.selectedGroupKey = restoredGroup.key;
          state.selectedRunId = restoredRunId;
          state.evidenceVisible = previous.evidenceVisible && Boolean(restoredRunId);
          if (state.evidenceVisible) {
            renderEvidenceShell(restoredGroup);
            if (previous.detail && previous.detail.id === restoredRunId) {
              renderDetail(previous.detail);
              renderIssues(previous.detail);
              setEvidenceStatus(`只读展示：${previous.detail.id}`);
            } else {
              await loadRun(restoredRunId, restoredGroup.key);
              if (!listGate.isCurrent(request)) return;
            }
          } else {
            setHidden(elements.evidenceSection, true);
            renderRunOptionsForGroup(null);
            renderDetailPlaceholder('选择“查看组内证据”后加载单次运行详情。');
            setEvidenceStatus('选择“查看组内证据”后加载单次运行详情。');
          }
        }
      } else {
        state.selectedGroupKey = '';
        state.selectedRunId = '';
        state.evidenceVisible = false;
        setHidden(elements.evidenceSection, true);
        renderRunOptionsForGroup(null);
        renderDetailPlaceholder('选择“查看组内证据”后加载单次运行详情。');
        setEvidenceStatus('选择“查看组内证据”后加载单次运行详情。');
      }
      renderSummary();
      renderSections();
      updateControls();
      setControlsStatus(
        `已加载 ${state.runs.length} 条历史运行，聚合为 ${state.groups.length} 个策略分组。`,
      );
    } catch (error) {
      if (isAbortError(error) || !listGate.isCurrent(request)) return;
      const message = error && typeof error.message === 'string' ? error.message : UNKNOWN;
      state.runs = [];
      state.listLoading = false;
      state.groups = [];
      state.groupOptions = { modes: [], approvalSources: [], batches: [] };
      state.filters = { mode: '', approvalSource: ALL_FILTER, batchId: ALL_FILTER };
      state.listTruncated = false;
      state.selectedGroupKey = '';
      state.selectedRunId = '';
      state.evidenceVisible = false;
      state.detail = null;
      setHidden(elements.evidenceSection, true);
      renderRunOptionsForGroup(null);
      renderOptions();
      renderTruncationNotice();
      renderSummary();
      renderSections();
      renderDetailPlaceholder('历史运行列表加载失败。');
      setEvidenceStatus('历史运行列表加载失败。');
      showNotice('历史运行列表加载失败', `无法读取 /api/runs：${message}`, [
        '过期分组与运行详情已清除，请确认本地服务已启动且 API 可访问。',
      ]);
      setControlsStatus(`历史运行列表加载失败：${message}`);
    } finally {
      if (listGate.isCurrent(request)) {
        state.listLoading = false;
        listController = null;
        updateControls();
      }
    }
  }

  function currentSelectValue(select) {
    return select && typeof select.value === 'string' ? select.value : '';
  }

  function applyFilterChange() {
    state.filters = {
      mode: currentSelectValue(elements.modeSelect),
      approvalSource: currentSelectValue(elements.approvalSourceSelect) || ALL_FILTER,
      batchId: currentSelectValue(elements.batchSelect) || ALL_FILTER,
    };
    state.groups = buildScenarioGroups(state.runs, state.filters);
    hideEvidence();
    clearNotice();
    renderTruncationNotice();
    renderSummary();
    renderSections();
    setControlsStatus(
      state.groups.length
        ? `筛选已更新，当前展示 ${state.groups.length} 个策略分组。`
        : '当前筛选没有匹配的运行。',
    );
  }

  if (elements.modeSelect) elements.modeSelect.addEventListener('change', applyFilterChange);
  if (elements.approvalSourceSelect) {
    elements.approvalSourceSelect.addEventListener('change', applyFilterChange);
  }
  if (elements.batchSelect) elements.batchSelect.addEventListener('change', applyFilterChange);
  if (elements.runSelect) {
    elements.runSelect.addEventListener('change', (event) => {
      const runId = event && event.target ? displayText(event.target.value, '') : '';
      const group = selectedGroup();
      if (!runId || !group || !group.runs.some((run) => run.id === runId)) return;
      state.selectedRunId = runId;
      renderRunOptionsForGroup(group);
      loadRun(runId, group.key);
    });
  }
  if (elements.refreshRuns) {
    elements.refreshRuns.addEventListener('click', () => {
      loadRuns(true);
    });
  }

  setHidden(elements.evidenceSection, true);
  renderRunOptionsForGroup(null);
  renderDetailPlaceholder('选择“查看组内证据”后加载单次运行详情。');
  renderOptions();
  renderTruncationNotice();
  renderSummary();
  renderSections();
  loadRuns(false);

  return {
    loadRuns,
    loadRun,
    openGroupEvidence,
    getState() {
      return {
        runs: state.runs.map((run) => ({ ...run })),
        groups: state.groups.map((group) => ({
          ...group,
          runs: group.runs.map((run) => ({ ...run })),
        })),
        filters: { ...state.filters },
        selectedGroupKey: state.selectedGroupKey,
        selectedId: state.selectedRunId,
        selectedRunId: state.selectedRunId,
        evidenceVisible: state.evidenceVisible,
        listTruncated: state.listTruncated,
        listLoading: state.listLoading,
        detailLoading: state.detailLoading,
      };
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initializeDashboard();
}
