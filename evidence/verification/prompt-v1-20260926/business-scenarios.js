const ROBOT_ID = 'R-03';
const TASK_ID = 'TASK-502';
const HEALTHY_FIXTURE = {
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
const NAV_FAULT_FIXTURE = {
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
const UNKNOWN_FAULT_FIXTURE = {
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
const BENIGN_FAILURES = {
    restart_navigation: ['SUCCESS'],
    force_reboot: ['SUCCESS'],
};
const DOUBLE_TIMEOUT_FAILURES = {
    restart_navigation: ['TIMEOUT', 'TIMEOUT'],
    force_reboot: ['SUCCESS'],
};
function cloneFixture(fixture) {
    return {
        robots: fixture.robots.map((robot) => ({ ...robot })),
        tasks: fixture.tasks.map((task) => ({ ...task })),
    };
}
function cloneFailures(failures) {
    return {
        restart_navigation: [...failures.restart_navigation],
        force_reboot: [...failures.force_reboot],
    };
}
function makeScript(scenarioId) {
    let index = 0;
    const call = (name, args) => {
        index += 1;
        return { id: `${scenarioId}-call-${index}`, name, arguments: args };
    };
    return call;
}
function asTurns(calls, summary) {
    return [
        ...calls.map((call) => ({ kind: 'tool-calls', calls: [call] })),
        { kind: 'text', text: `${summary} 结论只依据工具返回与真实状态读取。` },
    ];
}
const BINDING_AND_SOP = '第一步必须依次读取 robot 状态与 task 状态并确认二者绑定一致，随后读取 SOP 并严格遵循 SOP 步骤。';
const SAFETY_RULES = [
    '只允许使用已注册的七个工具；不得假设、编造或推断机器人状态。',
    '每个关键写操作成功后必须重新读取 robot 与 task 状态验证结果，禁止以模型文字判定成功。',
    '机器人保护动作重试必须由你显式发起，策略层不会替你重试。',
    '出现 FATAL_FAILURE、SOP 缺失、审批拒绝、审批取消或审批超时时，立即停止机器人动作并调用 create_maintenance_ticket 创建一个工单。',
    '禁止在未获得批准时执行 force_reboot，也不要通过任何参数伪造审批。',
].join('');
const FULL_FORCE_RULES = [
    '最多允许 2 次 restart_navigation；两次连续失败后才允许申请 force_reboot。',
    'force_reboot 必须经过外部人工审批；得到批准后必须先读取 robot 与 task，再调用 resume_task，并在 resume 成功后再次读取 robot 与 task 验证绑定与任务状态。',
].join('');
const FAIL_FAST_RULES = [
    '本次运行使用 fail-fast 恢复策略：第一次恢复动作失败后不得重试，不得申请或执行 force_reboot，只能创建维护工单并安全结束。',
].join('');
const RESUME_RULES = '任务可恢复时应调用 resume_task，并在 resume 成功后再次读取 robot 与 task 状态验证绑定与任务是否真实进入 RUNNING。';
function buildPrompt(scenarioId, config) {
    const header = `RobotOps 运维任务：机器人 ${ROBOT_ID} 的任务 ${TASK_ID} 需要巡检与恢复。`;
    const common = `${header}\n${SAFETY_RULES}\n${config === 'fail-fast' ? FAIL_FAST_RULES : FULL_FORCE_RULES}`;
    switch (scenarioId) {
        case 'happy_path':
            return `${common}\n${BINDING_AND_SOP}当前机器人无故障且任务处于 PAUSED：不要执行任何修复动作，只调用 resume_task 恢复任务。\n${RESUME_RULES}`;
        case 'navigation_restart_success':
            return `${common}\n${BINDING_AND_SOP}导航故障需要先通过 restart_navigation 恢复：首次 restart 成功后再读取 robot 状态确认故障已清除。\n${RESUME_RULES}`;
        case 'navigation_restart_fail_then_reboot':
            return `${common}\n${BINDING_AND_SOP}导航故障需要按 SOP 先尝试 restart_navigation。若首次失败，可由你显式重试一次；只有连续两次失败后才允许申请 force_reboot。\n${RESUME_RULES}`;
        case 'approval_rejected':
            return `${common}\n${BINDING_AND_SOP}导航故障需要按 SOP 先尝试 restart_navigation。若首次失败，可由你显式重试一次；只有连续两次失败后才允许申请 force_reboot，并且必须等待外部审批结果。\n若审批被拒绝、取消或超时，不得再请求或执行 force_reboot，机器人必须保持原故障状态，并立即创建维护工单。`;
        case 'sop_missing':
            return `${common}\n先读取 robot 与 task 状态并确认绑定，然后读取 SOP。若 SOP 查询失败，禁止猜测任何修复动作，立即停止机器人动作并创建维护工单。`;
        default:
            return common;
    }
}
function buildTurns(scenarioId, config) {
    const call = makeScript(scenarioId);
    const robot = () => call('get_robot_status', { robot_id: ROBOT_ID });
    const task = () => call('get_task_status', { task_id: TASK_ID });
    const sop = (errorCode) => call('search_sop', { error_code: errorCode });
    const restart = () => call('restart_navigation', { robot_id: ROBOT_ID });
    const force = () => call('force_reboot', { robot_id: ROBOT_ID });
    const resume = () => call('resume_task', { robot_id: ROBOT_ID, task_id: TASK_ID });
    const ticket = (reason) => call('create_maintenance_ticket', { robot_id: ROBOT_ID, reason });
    switch (scenarioId) {
        case 'happy_path':
            return asTurns([robot(), task(), resume(), robot(), task()], '任务恢复巡检完成。');
        case 'navigation_restart_success':
            return asTurns([robot(), task(), sop('NAV_042'), restart(), robot(), task(), resume(), robot(), task()], '导航故障已通过 restart 恢复。');
        case 'navigation_restart_fail_then_reboot': {
            if (config === 'fail-fast') {
                return asTurns([robot(), task(), sop('NAV_042'), restart(), ticket('fail-fast: 首次 restart_navigation 失败后停止恢复动作')], 'fail-fast 策略下首次恢复失败，已停止机器人动作。');
            }
            return asTurns([
                robot(), task(), sop('NAV_042'),
                restart(), restart(),
                force(),
                robot(), task(), resume(), robot(), task(),
            ], '两次 restart 失败后经审批完成 force_reboot 并恢复任务。');
        }
        case 'approval_rejected': {
            if (config === 'fail-fast') {
                return asTurns([robot(), task(), sop('NAV_042'), restart(), ticket('fail-fast: 首次 restart_navigation 失败后停止恢复动作')], 'fail-fast 策略下首次恢复失败，已停止机器人动作。');
            }
            return asTurns([
                robot(), task(), sop('NAV_042'),
                restart(), restart(),
                force(),
                ticket('force_reboot 审批被拒绝，机器人保持故障状态'),
            ], '审批未通过，已停止机器人动作。');
        }
        case 'sop_missing':
            return asTurns([robot(), task(), sop('UNKNOWN_999'), ticket('SOP 缺失，无法确认恢复步骤')], 'SOP 缺失，已停止机器人动作并创建工单。');
        default:
            return asTurns([], '场景未定义。');
    }
}
function fixtureFor(scenarioId) {
    switch (scenarioId) {
        case 'happy_path':
            return HEALTHY_FIXTURE;
        case 'sop_missing':
            return UNKNOWN_FAULT_FIXTURE;
        default:
            return NAV_FAULT_FIXTURE;
    }
}
function failuresFor(scenarioId) {
    return scenarioId === 'navigation_restart_fail_then_reboot' || scenarioId === 'approval_rejected'
        ? DOUBLE_TIMEOUT_FAILURES
        : BENIGN_FAILURES;
}
export function getBusinessScenario(id, config) {
    return {
        fixture: cloneFixture(fixtureFor(id)),
        failures: cloneFailures(failuresFor(id)),
        prompt: buildPrompt(id, config),
        turns: buildTurns(id, config),
        scriptedDecision: id === 'approval_rejected' ? 'rejected' : 'approved',
    };
}
