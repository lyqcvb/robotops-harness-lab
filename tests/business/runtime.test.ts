import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_NAMES } from '../../src/contracts/business.js';
import { SCENARIO_IDS, type RecoveryMode } from '../../src/contracts/run.js';
import { nativeApprovalGranted } from '../../src/harness/business-runtime.js';
import { getBusinessScenario } from '../../src/harness/business-scenarios.js';
import { TOOL_DESCRIPTIONS, validateBaseUrl } from '../../src/harness/runtime-support.js';

// Model behaviour is verified against the real model (npm run eval / test:e2e); the
// runtime and approval chain are regressed keylessly in runtime-chain.test.ts. These
// tests cover the deterministic contracts the runtime is built from.

test('nativeApprovalGranted accepts only the exact durable run/session/call pairing', () => {
  const asked = {
    type: 'approval/asked',
    seq: 5,
    run_id: 'run-1',
    session_id: 'session-1',
    data: { id: 'approval-1', toolName: 'force_reboot', callId: 'call-1' },
  };
  const decided = {
    type: 'approval/decided',
    seq: 6,
    run_id: 'run-1',
    session_id: 'session-1',
    data: { id: 'approval-1', outcome: 'allowed-once' },
  };
  const ctx = { run_id: 'run-1', session_id: 'session-1', call_id: 'call-1' };

  assert.equal(nativeApprovalGranted([asked, decided], ctx), true);
  assert.equal(nativeApprovalGranted([], ctx), false);
  assert.equal(nativeApprovalGranted([asked], ctx), false);
  assert.equal(nativeApprovalGranted([decided], ctx), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, run_id: 'run-2' }), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, session_id: 'session-2' }), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, call_id: 'call-2' }), false);
  assert.equal(nativeApprovalGranted([asked, decided], { ...ctx, session_id: null }), false);
  assert.equal(
    nativeApprovalGranted([asked, { ...decided, data: { id: 'approval-9', outcome: 'allowed-once' } }], ctx),
    false,
  );
  assert.equal(
    nativeApprovalGranted([asked, { ...decided, data: { id: 'approval-1', outcome: 'rejected' } }], ctx),
    false,
  );
  assert.equal(nativeApprovalGranted([asked, { ...decided, seq: 3 }], ctx), false);
  assert.equal(nativeApprovalGranted([asked, asked, decided], ctx), false);
  assert.equal(nativeApprovalGranted([asked, decided, decided], ctx), false);
  assert.equal(nativeApprovalGranted([asked, { ...decided, seq: undefined }], ctx), false);
  assert.equal(nativeApprovalGranted([{ ...asked, seq: undefined }, decided], ctx), false);
  assert.equal(
    nativeApprovalGranted([asked, { ...decided, data: { id: 'approval-1', outcome: 'unavailable' } }], ctx),
    false,
  );
  assert.equal(nativeApprovalGranted([decided, asked], ctx), false);
  assert.equal(
    nativeApprovalGranted([{ ...asked, data: { ...asked.data, toolName: 'restart_navigation' } }, decided], ctx),
    false,
  );
});

test('all five scenarios share one state-based prompt per recovery policy', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const config of configs) {
    const prompts = SCENARIO_IDS.map((id) => getBusinessScenario(id, config).prompt);
    assert.equal(new Set(prompts).size, 1, config + ' must not reveal scenario-specific instructions');
    for (const prompt of prompts) {
      for (const id of SCENARIO_IDS) assert.equal(prompt.includes(id), false);
      assert.doesNotMatch(prompt, /NAV_042|UNKNOWN_999/);
    }
  }

  const full = getBusinessScenario('happy_path', 'full').prompt;
  const failFast = getBusinessScenario('happy_path', 'fail-fast').prompt;
  assert.notEqual(full, failFast);
  assert.deepEqual(full.split('\n').slice(1).map((step) => step.slice(0, 2)), [
    '1.', '2.', '3.', '4.', '5.', '6.', '7.', '8.',
  ]);
  assert.equal(
    full.replace(/^4\. .+$/m, ''),
    failFast.replace(/^4\. .+$/m, ''),
    'only the recovery policy section may differ',
  );
});

test('the shared prompt resumes healthy bindings without SOP lookup or invented fault codes', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const config of configs) {
    const prompt = getBusinessScenario('happy_path', config).prompt;
    const steps = prompt.split('\n');
    const initial = steps[1] ?? '';
    const healthy = steps[2] ?? '';
    const sop = steps[3] ?? '';
    const limits = steps[8] ?? '';

    assert.match(prompt, /检查机器人 R-03 执行 TASK-502.*尽可能恢复任务/);
    for (const name of TOOL_NAMES) assert.ok(initial.includes(name));
    assert.match(initial, /第一步依次调用 get_robot_status 读取 R-03，再调用 get_task_status 读取 TASK-502/);
    assert.match(initial, /双向绑定 robot\.current_task=TASK-502 且 task\.robot_id=R-03/);
    assert.match(initial, /只以真实工具返回为准/);
    assert.match(healthy, /robot\.state=IDLE、error_code=null、task\.status=PAUSED 且双向绑定一致，直接调用 resume_task/);
    assert.match(healthy, /随后分别调用 get_robot_status 和 get_task_status.*robot\.state=MOVING、task\.status=RUNNING/);
    assert.match(healthy, /不调用 search_sop，不执行 restart_navigation 或 force_reboot/);
    assert.match(healthy, /不得编造 NO_FAULT.*不得用空值错误码查询 SOP/);
    assert.match(sop, /仅当 robot\.state=ERROR.*真实非空 error_code.*该 error_code 原值调用 search_sop/);
    assert.match(sop, /禁止编造错误码.*不能把 null 或空字符串当作故障码/);
    assert.match(sop, /找不到 SOP 时，不猜测修复动作，停止机器人动作.*create_maintenance_ticket 创建一张工单并安全结束/);
    assert.match(limits, /模型调用、工具调用、主动运行时间和审批等待预算/);
    assert.match(limits, /不得用反复请求绕过预算或权限层/);
    assert.match(limits, /禁止以模型文字判定成功.*禁止硬编码成功结论/);
    assert.match(limits, /目标只恢复到 RUNNING，而非 COMPLETED/);
  }
});

test('the prompt distinguishes a controlled approval request from executing force_reboot', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const config of configs) {
    const steps = getBusinessScenario('happy_path', config).prompt.split('\n');
    const approval = steps[5] ?? '';
    const verification = steps[6] ?? '';
    const stop = steps[7] ?? '';

    assert.match(approval, /仅在当前恢复策略允许且需要强制重启时，通过 force_reboot 工具发起/);
    assert.match(approval, /调用 force_reboot 工具是提交受控审批请求，不代表动作已执行/);
    assert.match(approval, /权限层会在任何动作开始前暂停.*外部人或测试宿主的一次性批准.*未批准时重启动作不会执行/);
    assert.match(approval, /你不能批准自己/);
    assert.match(approval, /不要在最终自然语言中索要许可并提前结束.*需要审批时通过该工具发起/);
    assert.match(approval, /绝不传 approved 字段，不伪造审批或绕过权限层/);
    assert.match(approval, /只有工具返回 SUCCESS 后.*读回状态并继续.*外部批准本身不代表动作成功/);
    assert.match(approval, /收到 DENIED、审批取消或超时.*停止机器人动作并建工单/);
    assert.match(verification, /restart_navigation 或 force_reboot 返回 SUCCESS 后，先分别调用 get_robot_status 和 get_task_status/);
    assert.match(verification, /robot\.state=IDLE、error_code=null、task\.status=PAUSED 且双向绑定一致，然后才调用 resume_task/);
    assert.match(verification, /resume_task 返回 SUCCESS 后，再次分别调用 get_robot_status 和 get_task_status.*robot\.state=MOVING、task\.status=RUNNING 且双向绑定一致/);
    assert.match(stop, /FATAL_FAILURE、SOP 缺失、DENIED、审批拒绝、审批取消或审批超时.*停止后续机器人动作/);
    assert.match(stop, /不再请求重启或恢复任务.*剩余预算和宿主允许.*create_maintenance_ticket 创建一张工单.*不重复建单/);
  }
});

test('full prompts require an explicit bounded retry before submitting a controlled reboot request', () => {
  for (const id of SCENARIO_IDS) {
    const policy = getBusinessScenario(id, 'full').prompt.split('\n')[4] ?? '';
    assert.match(policy, /full 恢复策略.*按照查得的 SOP 调用 restart_navigation/);
    assert.match(policy, /首次返回 RETRYABLE_FAILURE.*由你显式重试一次.*总共最多 2 次.*不会替你重试/);
    assert.match(policy, /连续两次返回 RETRYABLE_FAILURE 后，应调用 force_reboot 提交受控审批请求/);
    assert.match(policy, /不得进行第三次 restart_navigation/);
    assert.match(policy, /返回 SUCCESS 后进入第 6 步.*FATAL_FAILURE 不重试/);
    assert.doesNotMatch(policy, /fail-fast/);
  }
});

test('fail-fast prompts override SOP retry advice without retaining a conflicting retry branch', () => {
  for (const id of SCENARIO_IDS) {
    const prompt = getBusinessScenario(id, 'fail-fast').prompt;
    const policy = prompt.split('\n')[4] ?? '';
    assert.match(policy, /fail-fast 恢复策略.*按照查得的 SOP 调用 restart_navigation/);
    assert.match(policy, /首次恢复动作失败（包括 RETRYABLE_FAILURE）后，立即停止后续机器人动作/);
    assert.match(policy, /不重试、不调用 force_reboot、不进入审批/);
    assert.match(policy, /此策略优先于 SOP 中的可重试建议/);
    assert.match(policy, /create_maintenance_ticket 创建一张工单并安全结束/);
    assert.match(policy, /返回 SUCCESS 后.*读取真实状态并验证恢复结果/);
    assert.doesNotMatch(prompt, /显式重试一次|总共最多 2 次|连续两次返回 RETRYABLE_FAILURE|第三次 restart_navigation/);
  }
});

test('scenario fixtures, failure sequences and host approval decisions are fixed per scenario', () => {
  const configs: readonly RecoveryMode[] = ['full', 'fail-fast'];
  for (const id of SCENARIO_IDS) {
    for (const config of configs) {
      const scenario = getBusinessScenario(id, config);
      const robot = scenario.fixture.robots[0];
      const task = scenario.fixture.tasks[0];
      assert.equal(robot?.robot_id, 'R-03', id);
      assert.equal(robot?.current_task, 'TASK-502', id);
      assert.equal(task?.task_id, 'TASK-502', id);
      assert.equal(task?.robot_id, 'R-03', id);
      assert.equal(task?.status, 'PAUSED', id);

      const expectedFault = id === 'happy_path' ? null : id === 'sop_missing' ? 'UNKNOWN_999' : 'NAV_042';
      assert.equal(robot?.error_code, expectedFault, id);
      assert.equal(robot?.state, expectedFault === null ? 'IDLE' : 'ERROR', id);

      const doubleTimeout = id === 'navigation_restart_fail_then_reboot' || id === 'approval_rejected';
      assert.deepEqual(
        scenario.failures.restart_navigation,
        doubleTimeout ? ['TIMEOUT', 'TIMEOUT'] : ['SUCCESS'],
        id,
      );
      assert.deepEqual(scenario.failures.force_reboot, ['SUCCESS'], id);
      assert.equal(scenario.scriptedDecision, id === 'approval_rejected' ? 'rejected' : 'approved', id);
    }
  }
  // Each call returns an independent copy, so a run cannot mutate the shared fixture.
  const first = getBusinessScenario('happy_path', 'full');
  (first.fixture.robots[0] as { state: string }).state = 'OFFLINE';
  assert.equal(getBusinessScenario('happy_path', 'full').fixture.robots[0]?.state, 'IDLE');
});

test('the native force_reboot description explains the request and pre-effect approval boundary', () => {
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS).sort(), [...TOOL_NAMES].sort());
  assert.equal(
    TOOL_DESCRIPTIONS.force_reboot,
    'Submit a controlled reboot request for a robot in ERROR state. The host requires external one-time approval before any side effects. Without approval, the action will not execute.',
  );
});

test('DEEPSEEK_BASE_URL accepts https, and http only for loopback test endpoints', () => {
  assert.equal(validateBaseUrl(undefined), undefined);
  assert.equal(validateBaseUrl('  '), undefined);
  assert.equal(validateBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.equal(validateBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(validateBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(validateBaseUrl('http://[::1]:8080'), 'http://[::1]:8080');
  assert.throws(() => validateBaseUrl('http://api.example.com'), /must use https/);
  assert.throws(() => validateBaseUrl('https://user:pass@api.example.com'), /userinfo/);
  assert.throws(() => validateBaseUrl('https://api.example.com/?key=x'), /query/);
  assert.throws(() => validateBaseUrl('https://api.example.com/#frag'), /fragment/);
});
