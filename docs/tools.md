# 工具参考：入参、出参与描述

本文按工具列出模型可见的七个工具的描述、入参，以及每种结果的 `status`、`error_code` 和模型收到的内容。安全边界、停止语义和预算定义以 [架构约束](./architecture.md) 为准，本文只做按工具展开的查表。

代码来源：

| 内容 | 位置 |
|---|---|
| 工具名、参数 schema、出参 schema | [tool-protocol.ts](../src/contracts/tool-protocol.ts) |
| 发给模型的工具描述、拦截说明前缀 | [runtime-support.ts](../src/harness/runtime-support.ts) `TOOL_DESCRIPTIONS`、`blockedResult` |
| 参数校验 | [tool-validation.ts](../src/tools/tool-validation.ts) `validateArguments` |
| 预算、次数上限、前置条件、停止 | [tool-boundary.ts](../src/tools/tool-boundary.ts) |
| 执行前拦截、二次核验、拦截结果回写给模型 | [business-runtime.ts](../src/harness/business-runtime.ts) |
| 审批决定与说明 | [runtime-approval.ts](../src/harness/runtime-approval.ts) |
| 业务实现 | [business-services.ts](../src/services/business-services.ts)、[robot-simulator.ts](../src/simulator/robot-simulator.ts) |

## 1. 总览

| 工具 | 类型 | 入参 | 成功时 `data` | 停止后可用 |
|---|---|---|---|---|
| `get_robot_status` | 只读 | `robot_id` | `RobotSnapshot` | 软停止后可用 |
| `get_task_status` | 只读 | `task_id` | `TaskSnapshot` | 软停止后可用 |
| `search_sop` | 只读 | `error_code` | `SopEntry` | 软停止后可用 |
| `restart_navigation` | 机器人动作 | `robot_id` | `RobotSnapshot` | 否 |
| `force_reboot` | 机器人动作，需审批 | `robot_id` | `RobotSnapshot` | 否 |
| `resume_task` | 机器人动作 | `robot_id`, `task_id` | `ResumeData` | 否 |
| `create_maintenance_ticket` | 收尾 | `robot_id`, `reason` | `MaintenanceTicket` | 软停止后可用 |

软停止原因：`FAIL_FAST`、`SOP_NOT_FOUND`、`APPROVAL_REJECTED`、`APPROVAL_REQUIRED`、`APPROVAL_UNAVAILABLE`。其余停止原因都是硬停止：运行时拒绝后续模型请求，模型不会再有调用工具的机会，由宿主补建一张维护工单。

## 2. 通用约定

### 2.1 入参规则

所有工具的参数都经过同一套校验，任一条不满足即在执行前拦截，返回 `DENIED` / `INVALID_ARGUMENTS`：

| 规则 | 说明部分（`reason` 中前缀之后的文字） |
|---|---|
| 必须是普通对象，不含 symbol 或不可枚举字段 | `tool args must be a plain object` 等 |
| 字段集合与 schema 完全一致，不能缺也不能多（例如传 `approved: true`） | `tool <name> requires exactly: <字段列表>` |
| 每个字段都是非空字符串（去除首尾空白后长度大于 0） | `argument <字段> must be a non-empty string` |
| `reason` 最长 2000 字符 | `argument reason must not exceed 2000 characters` |
| 其他字段最长 200 字符 | `argument <字段> must not exceed 200 characters` |

原生 schema 也设置了 `additionalProperties: false`，作为第二道检查。

`run_id`、`session_id`、`call_id` 由宿主注入 `ExecutionContext`，模型不能填写。

### 2.2 出参

模型收到的工具结果统一是四字段对象的 JSON 字符串，出参 schema 不允许额外字段：

```ts
interface ToolResult<T> {
  status: 'SUCCESS' | 'RETRYABLE_FAILURE' | 'FATAL_FAILURE' | 'DENIED';
  error_code: string | null; // SUCCESS 时为 null
  reason: string;            // 人可读说明
  data: T | null;            // 非 SUCCESS 时为 null
}
```

按调用在哪一步结束，结果分两类：

| 类别 | 何时出现 | `isError` | `reason` |
|---|---|---|---|
| **已执行** | 调用进入了工具体（`ToolBoundary.invoke`），业务实现给出结果 | `false` | 业务实现的说明 |
| **执行前拦截** | 调用在工具体之前被拦下：执行前检查（`preflight`）、审批（`approval`）、二次核验（`guard`） | `true` | 固定前缀 + 拦截原因 |

执行前拦截的 `reason` 以固定前缀开头，明确告诉模型工具没有运行、状态没有变化：

```text
BLOCKED BEFORE EXECUTION by <阶段>: the tool did not run and no robot or task state changed. <拦截原因>
```

`<阶段>` 取值：`the host policy check`（preflight）、`the approval step`（approval）、`the pre-dispatch verification`（guard）。

拦截示例（审批超时）：

```json
{
  "status": "DENIED",
  "error_code": "APPROVAL_TIMEOUT",
  "reason": "BLOCKED BEFORE EXECUTION by the approval step: the tool did not run and no robot or task state changed. No approval decision arrived before the approval deadline, so the request expired. The run is stopped; no further tool calls will be accepted.",
  "data": null
}
```

实现方式：拦截发生时，运行时把带前缀的结果记入 Trace，同时登记到待回写表；`tools/post-execute` 监听器用它替换 SDK 默认生成的 `Error: <文字>`，模型因此收到与 Trace 完全一致的四字段结果。唯一的例外是第 2.4 节的 SDK 层取消。

`status` 的含义：

| `status` | 含义 | Agent 应如何处理 |
|---|---|---|
| `SUCCESS` | 目标已满足；查询返回快照 | 继续下一步，写操作后要读回验证 |
| `RETRYABLE_FAILURE` | 动作本次失败，可以显式重试 | 在次数上限内重试，或升级处理 |
| `FATAL_FAILURE` | 当前动作不可继续 | 不重试，建工单并结束 |
| `DENIED` | 策略层或审批层拒绝 | 不重试同一请求，按停止规则收尾 |

### 2.3 数据类型

```ts
interface RobotSnapshot {
  robot_id: string;
  state: 'IDLE' | 'MOVING' | 'ERROR' | 'REBOOTING' | 'CHARGING' | 'OFFLINE';
  battery: number;
  error_code: string | null;
  current_task: string | null;
}

interface TaskSnapshot {
  task_id: string;
  robot_id: string;
  status: 'PENDING' | 'RUNNING' | 'PAUSED' | 'FAILED' | 'COMPLETED';
}

interface SopEntry {
  error_code: string;
  title: string;
  steps: string[];
}

interface ResumeData {
  robot: RobotSnapshot;
  task: TaskSnapshot;
  already_resumed: boolean;
}

interface MaintenanceTicket {
  ticket_id: string; // `${run_id}-${序号}`
  run_id: string;
  robot_id: string;
  reason: string;
}
```

### 2.4 通用结果（任何工具都可能出现）

下表及第 3 节各表中，「拦截阶段」为 `—` 表示已执行；其余值表示执行前拦截，`reason` 带第 2.2 节的前缀，表中只写前缀之后的拦截原因。

**执行前检查**（`ToolBoundary.preflight`，按以下顺序，命中即停）：

| `status` | `error_code` | 触发条件 | 拦截原因 | 拦截阶段 | 停止 |
|---|---|---|---|---|---|
| `DENIED` | `UNKNOWN_TOOL` | 工具名不在七工具白名单内 | `tool <name> is not one of the seven registered tools` | preflight | 否 |
| `DENIED` | `CONTEXT_MISMATCH` | 宿主注入的 run/session 与 Trace 不一致 | `tool context run/session does not match the trusted host context` | preflight | 否 |
| `DENIED` | `INVALID_CONTEXT` | 宿主注入的 `call_id` 为空 | `ctx.call_id must be non-empty` | preflight | 否 |
| `DENIED` | `INVALID_ARGUMENTS` | 参数不符合 2.1 的规则 | 见 2.1 | preflight | 否 |
| `DENIED` | `CANCELLED` | 调用已被取消 | `tool call was cancelled` | preflight | 硬停止 |
| `DENIED` | `BUDGET_EXHAUSTED` | 工具请求数超过预算（默认第 31 次） | `tool call budget is exhausted` | preflight | 硬停止 |
| `DENIED` | `ACTIVE_BUDGET_EXHAUSTED` | 主动运行时间达到预算 | `active-time budget is exhausted` | preflight | 硬停止 |
| `DENIED` | `APPROVAL_BUDGET_EXHAUSTED` | 累计审批等待时间达到预算 | `approval-wait budget is exhausted` | preflight | 硬停止 |
| `DENIED` | `RUN_STOPPED` | 运行已停止，且该工具在当前停止类型下不可用 | `soft stop disables this tool: <原因>`（硬停止时为 `hard stop ...`） | preflight | 已停止 |
| `FATAL_FAILURE` | `RUNTIME_ERROR` | 机器人动作检查时读取模拟器状态失败 | `failed to read simulator state: <错误>` | preflight | 硬停止 |

之后还有动作次数上限和 `force_reboot` 前置条件两项检查，见 3.4、3.5。

**工具体内**（调用已进入 `ToolBoundary.invoke`）：

| `status` | `error_code` | 触发条件 | 拦截阶段 | 停止 |
|---|---|---|---|---|
| `DENIED` | `CALL_REPLAY` | 同一个 `call_id` 已用过 | — | 否 |
| `DENIED` | `CONCURRENT_CALL` | 上一个工具调用尚未结束 | — | 否 |
| `FATAL_FAILURE` | `OUTPUT_SCHEMA_INVALID` | 业务实现返回的结果不符合四字段结构 | — | 硬停止 |
| `DENIED` | `CANCELLED` | 执行中被取消（AbortError） | — | 硬停止 |
| `FATAL_FAILURE` | `TRANSPORT_ERROR` / `PROTOCOL_ERROR` / `RUNTIME_ERROR` | 执行中抛出异常，按错误信息分类 | — | 硬停止（`<类别>_ERROR`） |

`CALL_REPLAY` 和 `CONCURRENT_CALL` 是防御性检查：SDK 为每次调用分配新的 `call_id`，并且一次只执行一个工具，正常路径不会出现。

**SDK 层取消**（不经过业务层，模型收到 SDK 的错误文本，Trace 没有对应的 `tool_result`）：

| 触发条件 | 模型收到 |
|---|---|
| 工具体开始前运行被取消 | `Error: tool call aborted before dispatch` |
| 工具体执行期间运行被取消 | `Error: tool call aborted` |

默认预算：模型请求 20 次、工具调用 30 次、主动运行 300 秒、审批等待 120 秒（[policy.ts](../src/contracts/policy.ts)）。模型请求次数耗尽时，拒绝的是下一次模型请求，不产生工具结果。

## 3. 各工具说明

每个工具的「模型可见描述」是注册时发给模型的原文。各表只列出该工具特有的结果，第 2.4 节的通用结果对所有工具都适用。

### 3.1 `get_robot_status`

- **模型可见描述**：`Read the current robot state, battery, fault code, and bound task.`
- **作用**：读取机器人当前快照，不改变状态，不计入恢复动作。

| 入参 | 类型 | 说明 |
|---|---|---|
| `robot_id` | string | 机器人 ID，例如 `R-03` |

| 结果 | `status` | `error_code` | `data` | 拦截阶段 |
|---|---|---|---|---|
| 成功 | `SUCCESS` | `null` | `RobotSnapshot` | — |
| 机器人不存在 | `FATAL_FAILURE` | `ROBOT_NOT_FOUND` | `null` | — |

成功示例：

```json
{
  "status": "SUCCESS",
  "error_code": null,
  "reason": "robot R-03 status retrieved",
  "data": { "robot_id": "R-03", "state": "ERROR", "battery": 31, "error_code": "NAV_042", "current_task": "TASK-502" }
}
```

Trace 事件：`state_read`（`entity: robot`）。

### 3.2 `get_task_status`

- **模型可见描述**：`Read the current task status and its bound robot.`
- **作用**：读取任务当前快照，不改变状态。

| 入参 | 类型 | 说明 |
|---|---|---|
| `task_id` | string | 任务 ID，例如 `TASK-502` |

| 结果 | `status` | `error_code` | `data` | 拦截阶段 |
|---|---|---|---|---|
| 成功 | `SUCCESS` | `null` | `TaskSnapshot` | — |
| 任务不存在 | `FATAL_FAILURE` | `TASK_NOT_FOUND` | `null` | — |

成功示例：

```json
{
  "status": "SUCCESS",
  "error_code": null,
  "reason": "task TASK-502 status retrieved",
  "data": { "task_id": "TASK-502", "robot_id": "R-03", "status": "PAUSED" }
}
```

Trace 事件：`state_read`（`entity: task`）。

### 3.3 `search_sop`

- **模型可见描述**：`Look up the recovery SOP for an error code. Never invent recovery steps.`
- **作用**：按错误码查询静态 SOP。当前只收录 `NAV_042`。

| 入参 | 类型 | 说明 |
|---|---|---|
| `error_code` | string | 从 `get_robot_status` 读到的真实错误码原值 |

| 结果 | `status` | `error_code` | `data` | 拦截阶段 | 停止 |
|---|---|---|---|---|---|
| 找到 SOP | `SUCCESS` | `null` | `SopEntry` | — | — |
| 未收录该错误码 | `FATAL_FAILURE` | `SOP_NOT_FOUND` | `null` | — | 软停止（`SOP_NOT_FOUND`） |

`NAV_042` 的返回内容：

```json
{
  "error_code": "NAV_042",
  "title": "NAV_042 navigation fault recovery",
  "steps": [
    "验证机器人任务双向绑定",
    "最多两次 restart 并读取成功状态",
    "连续失败申请 force 批准",
    "force 后读 IDLE/no fault",
    "resume 后读 robot/task"
  ]
}
```

软停止后只能读状态、查 SOP、建工单；机器人动作在 preflight 被拦截，返回 `RUN_STOPPED`，拦截原因为 `soft stop disables this tool: SOP_NOT_FOUND`。

### 3.4 `restart_navigation`

- **模型可见描述**：`Restart the navigation stack of a robot in ERROR state (recovery action, at most twice).`
- **作用**：重启导航。成功时清除故障码，机器人进入 `IDLE`；失败时保持 `ERROR`。

| 入参 | 类型 | 说明 |
|---|---|---|
| `robot_id` | string | 机器人 ID |

前置条件：机器人 `state=ERROR` 且 `error_code` 非空。每个 run 最多实际执行 2 次。

| 结果 | `status` | `error_code` | `data` | 拦截阶段 |
|---|---|---|---|---|
| 成功 | `SUCCESS` | `null` | `RobotSnapshot`（`state=IDLE`，`error_code=null`） | — |
| 超时（注入 `TIMEOUT`） | `RETRYABLE_FAILURE` | `TIMEOUT` | `null` | — |
| 动作失败（注入 `FATAL`） | `FATAL_FAILURE` | `ACTION_FAILED` | `null` | — |
| 注入序列已用完 | `FATAL_FAILURE` | `FAULT_SEQUENCE_EXHAUSTED` | `null` | — |
| 机器人不在故障状态 | `DENIED` | `PRECONDITION_FAILED` | `null` | — |
| 机器人不存在 | `FATAL_FAILURE` | `ROBOT_NOT_FOUND` | `null` | — |
| 已执行 2 次 | `DENIED` | `ACTION_BUDGET_EXHAUSTED` | `null` | preflight：`restart_navigation has already reached its per-run execution limit` |

- `ACTION_BUDGET_EXHAUSTED` 只拒绝本次调用，运行继续，模型仍可升级到 `force_reboot` 或建工单。
- 注入序列只在动作实际执行时消耗；被拦截的调用不消耗。
- `fail-fast` 策略下的停止规则见第 4 节。

Trace 事件：`action_started`、`action_finished`，成功时还有 `state_changed`（带 before/after 快照）。

### 3.5 `force_reboot`

- **模型可见描述**：`Submit a controlled reboot request for a robot in ERROR state. The host requires external one-time approval before any side effects. Without approval, the action will not execute.`
- **作用**：提交强制重启请求。调用后先暂停等待外部一次性审批，获批后才执行。成功时状态依次为 `ERROR → REBOOTING → IDLE`，并清除故障码。

| 入参 | 类型 | 说明 |
|---|---|---|
| `robot_id` | string | 机器人 ID |

不接受 `approved` 等授权字段，传入会因多余字段被拦截（`INVALID_ARGUMENTS`）。

前置条件：
- 机器人 `state=ERROR`，`error_code` 和 `current_task` 非空。
- 绑定任务为 `PAUSED`，且 `task.robot_id` 与机器人一致。
- 每个 run 最多实际执行 1 次。

执行流程与每一步可能的结果：

**第 1 步：执行前检查**（拦截阶段 preflight）。除第 2.4 节的通用检查外：

| 结果 | `status` | `error_code` | 拦截原因 | 停止 |
|---|---|---|---|---|
| 已执行 1 次 | `DENIED` | `ACTION_BUDGET_EXHAUSTED` | `force_reboot has already reached its per-run execution limit` | — |
| 机器人不满足前置条件，或机器人不存在 | `DENIED` | `PRECONDITION_FAILED` | `force_reboot requires an ERROR robot with a non-empty fault and current task` | — |
| 任务不满足前置条件 | `DENIED` | `PRECONDITION_FAILED` | `force_reboot requires a PAUSED current task with a consistent robot binding` | — |
| 同一 call 已有待决审批 | `DENIED` | `APPROVAL_REPLAY` | `force_reboot approval is already pending for this call` | — |
| 无法登记审批绑定 | `DENIED` | `APPROVAL_REQUEST_INVALID` | `force_reboot requires a valid one-time approval binding` | — |

**第 2 步：登记并等待审批**（拦截阶段 approval）。在审批账本登记一次性绑定（run、session、call_id、参数，以及当时机器人和任务状态的指纹），暂停主动计时，等待人工或脚本审批方的决定。每种未批准的结果都有单独的 `error_code` 和原因，原因说明发生了什么以及本次运行还允许做什么：

| 结果 | `status` | `error_code` | 拦截原因 | 停止 |
|---|---|---|---|---|
| 批准 | — | — | 进入第 3 步 | — |
| 审批被拒 | `DENIED` | `APPROVAL_REJECTED` | `The approver rejected force_reboot.` + 软停止说明 | 软停止（`APPROVAL_REJECTED`） |
| 批准时绑定已失效 | `DENIED` | `APPROVAL_INVALID` | `An approval arrived, but its one-time binding no longer matches this call (already used, cancelled or expired), so it was treated as a rejection.` + 软停止说明 | 软停止（`APPROVAL_REJECTED`） |
| 没有审批通道 | `DENIED` | `APPROVAL_UNAVAILABLE` | `No approval channel is configured for this run, so nobody can approve force_reboot.` + 软停止说明 | 软停止（`APPROVAL_UNAVAILABLE`） |
| 审批超时 | `DENIED` | `APPROVAL_TIMEOUT` | `No approval decision arrived before the approval deadline, so the request expired.` + 硬停止说明 | 硬停止（`APPROVAL_CANCELLED`） |
| 审批方取消了请求 | `DENIED` | `APPROVAL_CANCELLED` | `The approver cancelled the request without approving or rejecting it.` + 硬停止说明 | 硬停止（`APPROVAL_CANCELLED`） |
| 运行被取消，审批请求随之撤回 | `DENIED` | `APPROVAL_CANCELLED` | `The approval request was withdrawn because the run was cancelled before a decision arrived.` + 硬停止说明 | 硬停止（`APPROVAL_CANCELLED`） |
| 审批通道出错 | `DENIED` | `APPROVAL_ERROR` | `The approval channel failed before returning a decision (<错误信息>).` + 硬停止说明 | 硬停止（`APPROVAL_CANCELLED`） |
| 审批请求与待决调用不匹配 | `DENIED` | `APPROVAL_UNMATCHED` | `The approval request did not match a pending force_reboot call for this run and session, so it was rejected.` | — |

- 软停止说明：`Robot actions are disabled for the rest of this run; status reads, SOP lookup and maintenance tickets remain available.`
- 硬停止说明：`The run is stopped; no further tool calls will be accepted.`
- 审批超时、审批方取消、通道出错三种情况的停止原因都是 `APPROVAL_CANCELLED`，区分它们要看 `error_code` 和拦截原因。

**第 3 步：执行前二次核验**（拦截阶段 guard）。获批后重新执行第 1 步的检查，并确认存在与本次 run、session、call 匹配的原生 allowed-once 审批事件：

| 结果 | `status` | `error_code` | 拦截原因 |
|---|---|---|---|
| 第 1 步任一检查此时不通过（例如审批等待已用尽预算） | 同第 1 步或第 2.4 节 | 同第 1 步或第 2.4 节 | 同第 1 步或第 2.4 节 |
| 没有匹配的原生审批事件 | `DENIED` | `APPROVAL_NOT_GRANTED` | `force_reboot has no matching native allowed-once approval for this run, session, and call` |

**第 4 步：工具体执行**（已执行）。先在审批账本中消费授权，再调用模拟器：

| 结果 | `status` | `error_code` | `data` | 停止 |
|---|---|---|---|---|
| 执行成功 | `SUCCESS` | `null` | `RobotSnapshot`（`state=IDLE`，`error_code=null`） | — |
| 授权无法消费（绑定不匹配、已用过、状态指纹已变化） | `DENIED` | `APPROVAL_REQUIRED` | `null` | 软停止（`APPROVAL_REQUIRED`） |
| 超时（注入 `TIMEOUT`） | `RETRYABLE_FAILURE` | `TIMEOUT` | `null` | — |
| 动作失败（注入 `FATAL`） | `FATAL_FAILURE` | `ACTION_FAILED` | `null` | — |
| 注入序列已用完 | `FATAL_FAILURE` | `FAULT_SEQUENCE_EXHAUSTED` | `null` | — |

- 只要实际执行过，就算没有成功，次数上限也已用掉，再次调用会在第 1 步返回 `ACTION_BUDGET_EXHAUSTED`。所以 `RETRYABLE_FAILURE` 实际上无法重试。
- 模拟器自身也会检查机器人不存在（`ROBOT_NOT_FOUND`）和不在故障状态（`PRECONDITION_FAILED`），但第 1 步已经拦截了这两种情况，正常路径不会到达。
- 未获批时不会执行动作，也不会消耗注入序列，机器人状态保持不变。

Trace 事件：`approval_pending`、`approval_decided`、`approval_consumed`；执行后有 `action_started`、`action_finished`，以及两条 `state_changed`（进入 `REBOOTING`、进入 `IDLE`）。

### 3.6 `resume_task`

- **模型可见描述**：`Resume a paused task after the robot has been verified healthy.`
- **作用**：恢复暂停的任务。成功后机器人 `MOVING`，任务 `RUNNING`。

| 入参 | 类型 | 说明 |
|---|---|---|
| `robot_id` | string | 机器人 ID |
| `task_id` | string | 任务 ID |

前置条件：机器人 `IDLE` 且无故障码，任务 `PAUSED`，并且 `task.robot_id` 与 `robot.current_task` 双向绑定一致。

按以下顺序判断，命中即返回：

| 结果 | `status` | `error_code` | `data` | 拦截阶段 |
|---|---|---|---|---|
| 机器人不存在 | `FATAL_FAILURE` | `ROBOT_NOT_FOUND` | `null` | — |
| 任务不存在 | `FATAL_FAILURE` | `TASK_NOT_FOUND` | `null` | — |
| 绑定不一致 | `DENIED` | `BINDING_MISMATCH` | `null` | — |
| 已处于 `MOVING` + `RUNNING` | `SUCCESS` | `null` | `ResumeData`（`already_resumed=true`），不重复执行 | — |
| 状态不满足 | `DENIED` | `PRECONDITION_FAILED` | `null` | — |
| 成功恢复 | `SUCCESS` | `null` | `ResumeData`（`already_resumed=false`） | — |

成功示例：

```json
{
  "status": "SUCCESS",
  "error_code": null,
  "reason": "task TASK-502 resumed",
  "data": {
    "robot": { "robot_id": "R-03", "state": "MOVING", "battery": 31, "error_code": null, "current_task": "TASK-502" },
    "task": { "task_id": "TASK-502", "robot_id": "R-03", "status": "RUNNING" },
    "already_resumed": false
  }
}
```

Trace 事件：成功恢复时有 `action_started`、`state_changed`、`action_finished`；`already_resumed=true` 和失败结果不产生动作事件。

### 3.7 `create_maintenance_ticket`

- **模型可见描述**：`Create an idempotent maintenance ticket for a robot that could not be recovered.`
- **作用**：为无法恢复的机器人建维护工单。按 `run_id + robot_id + reason` 去重。

| 入参 | 类型 | 说明 |
|---|---|---|
| `robot_id` | string | 机器人 ID |
| `reason` | string | 建单原因，最长 2000 字符 |

| 结果 | `status` | `error_code` | `data` | 拦截阶段 |
|---|---|---|---|---|
| 新建 | `SUCCESS` | `null` | `MaintenanceTicket` | — |
| 相同三元组重复请求 | `SUCCESS` | `null` | 已有的 `MaintenanceTicket`，不新建 | — |
| 机器人不存在 | `FATAL_FAILURE` | `ROBOT_NOT_FOUND` | `null` | — |

成功示例：

```json
{
  "status": "SUCCESS",
  "error_code": null,
  "reason": "maintenance ticket run-xxx-1 created",
  "data": { "ticket_id": "run-xxx-1", "run_id": "run-xxx", "robot_id": "R-03", "reason": "SOP 缺失，无法确认恢复步骤" }
}
```

软停止后模型仍可调用。硬停止后模型没有机会再调用，如果运行中还没有工单，由宿主清理流程补建一张（[business-run.ts](../src/app/business-run.ts) `runHostCleanup`）。

Trace 事件：`ticket_created` 或 `ticket_reused`。

## 4. 结果触发的停止

| 触发 | 停止原因 | 类型 |
|---|---|---|
| `search_sop` 返回 `SOP_NOT_FOUND` | `SOP_NOT_FOUND` | 软停止 |
| `fail-fast` 策略下，任一机器人动作（`restart_navigation`、`force_reboot`、`resume_task`）已执行且返回非 `SUCCESS` 结果 | `FAIL_FAST` | 软停止 |
| `force_reboot` 审批被拒或批准时绑定失效 | `APPROVAL_REJECTED` | 软停止 |
| `force_reboot` 没有审批通道 | `APPROVAL_UNAVAILABLE` | 软停止 |
| `force_reboot` 授权无法消费 | `APPROVAL_REQUIRED` | 软停止 |
| `force_reboot` 审批超时、取消或通道出错 | `APPROVAL_CANCELLED` | 硬停止 |
| 预算耗尽、取消、输出结构不合法、执行异常 | 见第 2.4 节 | 硬停止 |

- `FAIL_FAST` 只由已执行的结果触发。执行前被拦截的调用（例如 `ACTION_BUDGET_EXHAUSTED`）不触发。
- 已处于软停止时，再出现硬停止原因会升级为硬停止。

## 5. 每次调用的 Trace 关联

每次工具调用以 `call_id` 关联以下事件：

- `tool_requested`：工具名、清洗后的参数、累计请求序号。
- `tool_result`：工具名、完整 `ToolResult`，与模型收到的内容一致。`phase` 字段标明拦截阶段：
  - `preflight`：执行前检查；
  - `approval`：审批；
  - `guard`：二次核验；
  - 无 `phase`：已执行。

业务实现内部的事件（`state_read`、`action_*`、`state_changed`、`ticket_*`）使用同一个 `call_id`，评测时可以从工具请求追到具体的状态变化。

SDK 层取消不写 `tool_result`，只出现在原生会话事件（`tool/result`）中。
