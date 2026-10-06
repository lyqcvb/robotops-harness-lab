export const SCENARIO_LABELS = {
  happy_path: '正常恢复',
  navigation_restart_success: '导航重启成功',
  navigation_restart_fail_then_reboot: '重试失败后强制重启',
  approval_rejected: '审批被拒绝',
  sop_missing: '找不到 SOP',
};

const UNKNOWN = 'unknown';
const SCENARIO_ORDER = Object.keys(SCENARIO_LABELS);
const MODE_ORDER = ['live', 'offline', UNKNOWN];
const CONFIG_ORDER = ['full', 'fail-fast', UNKNOWN];
const APPROVAL_ORDER = ['manual', 'scripted', 'none', UNKNOWN];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeField(value) {
  return typeof value === 'string' && value.length > 0 ? value : UNKNOWN;
}

function manifestField(run, key) {
  if (!isRecord(run) || !isRecord(run.manifest)) return UNKNOWN;
  return normalizeField(run.manifest[key]);
}

function descriptorFor(run) {
  const scenarioId = manifestField(run, 'scenario_id');
  return {
    key: JSON.stringify([
      manifestField(run, 'mode'),
      scenarioId,
      manifestField(run, 'config'),
      manifestField(run, 'approval_source'),
    ]),
    mode: manifestField(run, 'mode'),
    scenarioId,
    scenarioLabel: Object.prototype.hasOwnProperty.call(SCENARIO_LABELS, scenarioId)
      ? SCENARIO_LABELS[scenarioId]
      : scenarioId,
    config: manifestField(run, 'config'),
    approvalSource: manifestField(run, 'approval_source'),
    batchId: manifestField(run, 'batch_id'),
  };
}

function uniqueRuns(runs) {
  const seenIds = new Set();
  const result = [];

  for (const run of runs) {
    const id = isRecord(run) && typeof run.id === 'string' && run.id.length > 0 ? run.id : null;
    if (id !== null) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    result.push(run);
  }

  return result;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRanked(left, right, order) {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  const leftRank = leftIndex === -1 ? order.length : leftIndex;
  const rightRank = rightIndex === -1 ? order.length : rightIndex;

  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftIndex !== -1 && rightIndex !== -1) return 0;
  return compareText(left, right);
}

function matchesFilter(value, filter) {
  return filter === undefined || filter === 'all' || value === filter;
}

function newGroup(descriptor) {
  return {
    key: descriptor.key,
    mode: descriptor.mode,
    scenarioId: descriptor.scenarioId,
    scenarioLabel: descriptor.scenarioLabel,
    config: descriptor.config,
    approvalSource: descriptor.approvalSource,
    runs: [],
    total: 0,
    task: { success: 0, measured: 0, total: 0, rate: null },
    scenario: { success: 0, measured: 0, total: 0, rate: null },
    unsafe: { sum: 0, measured: 0, total: 0 },
    active: { meanMs: null, measured: 0, total: 0 },
    approvalWait: { meanMs: null, measured: 0, total: 0 },
    statuses: { pass: 0, fail: 0, blocked: 0, unknown: 0 },
    issueRuns: 0,
    integrityIssueRuns: 0,
  };
}

function addRun(group, run) {
  group.runs.push(run);
  group.total += 1;
  group.task.total += 1;
  group.scenario.total += 1;
  group.unsafe.total += 1;
  group.active.total += 1;
  group.approvalWait.total += 1;

  if (Array.isArray(run.issues) && run.issues.length > 0) group.issueRuns += 1;

  const metrics = isRecord(run.metrics) ? run.metrics : null;
  const status = metrics?.status;
  if (status === 'PASS') group.statuses.pass += 1;
  else if (status === 'FAIL') group.statuses.fail += 1;
  else if (status === 'BLOCKED') group.statuses.blocked += 1;
  else group.statuses.unknown += 1;

  if (metrics === null) return;

  if (typeof metrics.task_success === 'boolean') {
    group.task.measured += 1;
    if (metrics.task_success) group.task.success += 1;
  }
  if (typeof metrics.scenario_pass === 'boolean') {
    group.scenario.measured += 1;
    if (metrics.scenario_pass) group.scenario.success += 1;
  }
  if (Number.isSafeInteger(metrics.unsafe_action_count) && metrics.unsafe_action_count >= 0) {
    group.unsafe.sum += metrics.unsafe_action_count;
    group.unsafe.measured += 1;
  }
  if (Number.isFinite(metrics.active_ms) && metrics.active_ms >= 0) {
    group.active.meanMs = (group.active.meanMs ?? 0) + metrics.active_ms;
    group.active.measured += 1;
  }
  if (Number.isFinite(metrics.approval_wait_ms) && metrics.approval_wait_ms >= 0) {
    group.approvalWait.meanMs = (group.approvalWait.meanMs ?? 0) + metrics.approval_wait_ms;
    group.approvalWait.measured += 1;
  }
  if (Array.isArray(metrics.integrity_errors) && metrics.integrity_errors.length > 0) {
    group.integrityIssueRuns += 1;
  }
}

function finalizeGroup(group) {
  group.runs.sort((left, right) => {
    const leftId = isRecord(left) && typeof left.id === 'string' ? left.id : '';
    const rightId = isRecord(right) && typeof right.id === 'string' ? right.id : '';
    return compareText(rightId, leftId);
  });

  group.task.rate = group.task.measured === 0 ? null : group.task.success / group.task.measured;
  group.scenario.rate = group.scenario.measured === 0 ? null : group.scenario.success / group.scenario.measured;
  group.active.meanMs = group.active.measured === 0 ? null : group.active.meanMs / group.active.measured;
  group.approvalWait.meanMs = group.approvalWait.measured === 0
    ? null
    : group.approvalWait.meanMs / group.approvalWait.measured;

  return group;
}

export function buildScenarioGroups(runs, filters = {}) {
  const sourceRuns = Array.isArray(runs) ? runs : [];
  const groups = new Map();

  for (const run of uniqueRuns(sourceRuns)) {
    if (!isRecord(run)) continue;
    const descriptor = descriptorFor(run);
    if (
      !matchesFilter(descriptor.mode, filters.mode)
      || !matchesFilter(descriptor.approvalSource, filters.approvalSource)
      || !matchesFilter(descriptor.batchId, filters.batchId)
    ) {
      continue;
    }

    let group = groups.get(descriptor.key);
    if (group === undefined) {
      group = newGroup(descriptor);
      groups.set(descriptor.key, group);
    }
    addRun(group, run);
  }

  return [...groups.values()].map(finalizeGroup).sort((left, right) => (
    compareRanked(left.scenarioId, right.scenarioId, SCENARIO_ORDER)
    || compareText(left.scenarioId, right.scenarioId)
    || compareRanked(left.mode, right.mode, MODE_ORDER)
    || compareRanked(left.config, right.config, CONFIG_ORDER)
    || compareRanked(left.approvalSource, right.approvalSource, APPROVAL_ORDER)
    || compareText(left.key, right.key)
  ));
}

function sortedOptions(values, order) {
  return [...values].sort((left, right) => (
    compareRanked(left, right, order) || compareText(left, right)
  ));
}

export function getGroupingOptions(runs) {
  const modes = new Set();
  const approvalSources = new Set();
  const batches = new Set();

  for (const run of uniqueRuns(Array.isArray(runs) ? runs : [])) {
    if (!isRecord(run)) continue;
    modes.add(manifestField(run, 'mode'));
    approvalSources.add(manifestField(run, 'approval_source'));
    batches.add(manifestField(run, 'batch_id'));
  }

  return {
    modes: sortedOptions(modes, MODE_ORDER),
    approvalSources: sortedOptions(approvalSources, APPROVAL_ORDER),
    batches: [...batches].sort(compareText),
  };
}