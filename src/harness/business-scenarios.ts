import type { FailureSequences, SimulatorFixture } from '../contracts/business.js';
import type { RecoveryMode, ScenarioId } from '../contracts/run.js';

const ROBOT_ID = 'R-03';
const TASK_ID = 'TASK-502';

const HEALTHY_FIXTURE: SimulatorFixture = {
  robots: [
    {
      robot_id: ROBOT_ID,
      state: 'IDLE',
      battery: 31,
      error_code: null,
      current_task: TASK_ID,
    },
  ],
  tasks: [{ task_id: TASK_ID, robot_id: ROBOT_ID, status: 'PAUSED' }],
};

const NAV_FAULT_FIXTURE: SimulatorFixture = {
  robots: [
    {
      robot_id: ROBOT_ID,
      state: 'ERROR',
      battery: 31,
      error_code: 'NAV_042',
      current_task: TASK_ID,
    },
  ],
  tasks: [{ task_id: TASK_ID, robot_id: ROBOT_ID, status: 'PAUSED' }],
};

const UNKNOWN_FAULT_FIXTURE: SimulatorFixture = {
  robots: [
    {
      robot_id: ROBOT_ID,
      state: 'ERROR',
      battery: 31,
      error_code: 'UNKNOWN_999',
      current_task: TASK_ID,
    },
  ],
  tasks: [{ task_id: TASK_ID, robot_id: ROBOT_ID, status: 'PAUSED' }],
};

const BENIGN_FAILURES: FailureSequences = {
  restart_navigation: ['SUCCESS'],
  force_reboot: ['SUCCESS'],
};

const DOUBLE_TIMEOUT_FAILURES: FailureSequences = {
  restart_navigation: ['TIMEOUT', 'TIMEOUT'],
  force_reboot: ['SUCCESS'],
};

function cloneFixture(fixture: SimulatorFixture): SimulatorFixture {
  return {
    robots: fixture.robots.map((robot) => ({ ...robot })),
    tasks: fixture.tasks.map((task) => ({ ...task })),
  };
}

function cloneFailures(failures: FailureSequences): FailureSequences {
  return {
    restart_navigation: [...failures.restart_navigation],
    force_reboot: [...failures.force_reboot],
  };
}

const FULL_RECOVERY_RULES = [
  '4. 本次使用 full 恢复策略：仅在第 3 步取得 SOP 的故障分支，按照查得的 SOP 调用 restart_navigation。',
  '首次返回 RETRYABLE_FAILURE 时，由你显式重试一次，restart_navigation 总共最多 2 次，策略层不会替你重试。',
  '连续两次返回 RETRYABLE_FAILURE 后，应调用 force_reboot 提交受控审批请求，不得进行第三次 restart_navigation。',
  '任一恢复动作返回 SUCCESS 后进入第 6 步；FATAL_FAILURE 不重试，按第 7 步安全结束。',
].join('');

const FAIL_FAST_RULES = [
  '4. 本次使用 fail-fast 恢复策略：仅在第 3 步取得 SOP 的故障分支，按照查得的 SOP 调用 restart_navigation。',
  '首次恢复动作失败（包括 RETRYABLE_FAILURE）后，立即停止后续机器人动作，不重试、不调用 force_reboot、不进入审批。',
  '此策略优先于 SOP 中的可重试建议；调用 create_maintenance_ticket 创建一张工单并安全结束。',
  '恢复动作返回 SUCCESS 后仍须按第 6 步读取真实状态并验证恢复结果。',
].join('');

function buildPrompt(config: RecoveryMode): string {
  return [
    `RobotOps 运维任务：请检查机器人 ${ROBOT_ID} 执行 ${TASK_ID} 配送任务的状态与故障原因，并尽可能恢复任务。`,
    [
      '1. 只使用已注册的七个工具：get_robot_status、get_task_status、search_sop、restart_navigation、force_reboot、resume_task、create_maintenance_ticket。',
      `第一步依次调用 get_robot_status 读取 ${ROBOT_ID}，再调用 get_task_status 读取 ${TASK_ID}，`,
      `核实双向绑定 robot.current_task=${TASK_ID} 且 task.robot_id=${ROBOT_ID}。`,
      '所有分支只以真实工具返回为准，不假设或编造当前状态。',
    ].join(''),
    [
      '2. 若读到 robot.state=IDLE、error_code=null、task.status=PAUSED 且双向绑定一致，直接调用 resume_task。',
      '随后分别调用 get_robot_status 和 get_task_status，确认 robot.state=MOVING、task.status=RUNNING 且绑定一致。',
      '该健康分支不调用 search_sop，不执行 restart_navigation 或 force_reboot；不得编造 NO_FAULT，也不得用空值错误码查询 SOP。',
      '验证通过即按真实读回结果结束，不进入后续故障恢复分支。',
    ].join(''),
    [
      '3. 仅当 robot.state=ERROR 且工具返回真实非空 error_code 时，才用该 error_code 原值调用 search_sop。',
      '禁止编造错误码，不能把 null 或空字符串当作故障码。找不到 SOP 时，不猜测修复动作，停止机器人动作，',
      '调用 create_maintenance_ticket 创建一张工单并安全结束。',
    ].join(''),
    config === 'fail-fast' ? FAIL_FAST_RULES : FULL_RECOVERY_RULES,
    [
      '5. 审批请求语义：仅在当前恢复策略允许且需要强制重启时，通过 force_reboot 工具发起。',
      '调用 force_reboot 工具是提交受控审批请求，不代表动作已执行。工具内部权限层会在任何动作开始前暂停，',
      '等待外部人或测试宿主的一次性批准；未批准时重启动作不会执行。',
      '你不能批准自己，也不要在最终自然语言中索要许可并提前结束；需要审批时通过该工具发起。',
      '绝不传 approved 字段，不伪造审批或绕过权限层。只有工具返回 SUCCESS 后，才按第 6 步读回状态并继续；',
      '外部批准本身不代表动作成功。收到 DENIED、审批取消或超时，按第 7 步停止机器人动作并建工单。',
    ].join(''),
    [
      '6. 每个关键写操作成功后都必须读回验证：restart_navigation 或 force_reboot 返回 SUCCESS 后，',
      '先分别调用 get_robot_status 和 get_task_status，确认 robot.state=IDLE、error_code=null、task.status=PAUSED 且双向绑定一致，',
      '然后才调用 resume_task。resume_task 返回 SUCCESS 后，再次分别调用 get_robot_status 和 get_task_status，',
      '确认 robot.state=MOVING、task.status=RUNNING 且双向绑定一致；不能跳过任何一次读回或凭批准推断状态。',
    ].join(''),
    [
      '7. 出现 FATAL_FAILURE、SOP 缺失、DENIED、审批拒绝、审批取消或审批超时时，立即停止后续机器人动作，',
      '不再请求重启或恢复任务；在剩余预算和宿主允许的范围内调用 create_maintenance_ticket 创建一张工单，然后安全结束，不重复建单。',
    ].join(''),
    [
      '8. 遵守宿主的模型调用、工具调用、主动运行时间和审批等待预算；一次只调用一个工具，不得用反复请求绕过预算或权限层。',
      '结果只依据真实工具返回与最终状态读取，禁止以模型文字判定成功，禁止硬编码成功结论。',
      '目标只恢复到 RUNNING，而非 COMPLETED；没有真实读回证据就不能宣称恢复成功。',
    ].join(''),
  ].join('\n');
}

function fixtureFor(scenarioId: ScenarioId): SimulatorFixture {
  switch (scenarioId) {
    case 'happy_path':
      return HEALTHY_FIXTURE;
    case 'sop_missing':
      return UNKNOWN_FAULT_FIXTURE;
    default:
      return NAV_FAULT_FIXTURE;
  }
}

function failuresFor(scenarioId: ScenarioId): FailureSequences {
  return scenarioId === 'navigation_restart_fail_then_reboot' || scenarioId === 'approval_rejected'
    ? DOUBLE_TIMEOUT_FAILURES
    : BENIGN_FAILURES;
}

export interface BusinessScenario {
  readonly fixture: SimulatorFixture;
  readonly failures: FailureSequences;
  readonly prompt: string;
  readonly scriptedDecision: 'approved' | 'rejected';
}

export function getBusinessScenario(
  id: ScenarioId,
  config: RecoveryMode,
): BusinessScenario {
  return {
    fixture: cloneFixture(fixtureFor(id)),
    failures: cloneFailures(failuresFor(id)),
    prompt: buildPrompt(config),
    scriptedDecision: id === 'approval_rejected' ? 'rejected' : 'approved',
  };
}
