# 阶段 3：DeepSeek Harness 集成

依据：[架构约束的业务契约](architecture.md#业务契约) 与 [项目指令](../AGENTS.md)。共同约束冲突时以架构约束为准。

> 状态：`DONE`。原生 Harness、七工具、真实 Services/Simulator 和默认 `restart_success` E2E 已通过真实 live 验证；证据见 [Stage 3 E2E](../results/20260926T103732Z-live-65ffe67a-e970-4d03-bced-0c3b89e3f721/) / [e2e.log](../evidence/verification/stage3-live-20260926T183729/e2e.log)。本文其余内容保留原始基线验收条件。
>
> 证据索引：[当前 v2 unit 164/164](../evidence/verification/prompt-v2-live-20260926T191229/test-unit.log)、[离线十组合](../evidence/verification/stage2-5-20260926T183558-905452/test-integration.log)、[真实 core scripted](../results/20260926T104048Z-live-6628dd24-07a3-4a50-894b-746db699936e/)、[当前实现报告](./implementation-report.md)。该 E2E 的 approval source 是 `scripted`，不证明 manual。

## 目标

把 DeepSeek Harness 的原生 Agent Loop 真实接入本项目的 RobotOps 工具链，形成唯一执行路径：

```text
Harness 原生 AgentLoop
→ RobotOps 工具与策略
→ Services
→ Simulator
```

阶段 3 只完成真实集成与 Happy Path：模型基于真实工具结果决策，`restart_navigation` 首次实际成功，动作后必须真实读取机器人状态；不实现阶段 4 的失败恢复与人工审批业务流程。验收依据是运行证据，不是模型文字、临时 stub 或预期输出。

## 前置条件

### 阶段 0 硬门禁

阶段 0 必须已经真实完成并留下可复核证据：工具注册、LLM 调用、执行前审批、事件读取均实际运行成功，且实际包版本已锁定。SDK/API 签名只以该锁定版本的源码、类型或运行时验证为准，不凭记忆、示例或未锁定文档确定。任一门禁未通过时，阶段 3 为 BLOCKED，不能以“仅缺模型”等其他措辞标记完成。

[tools.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md) 的预览语义仅作参考：`ask` 审批是 allowed-once 执行，缺通道时拒绝；但原生 `tools/pre-execute` 的 `next()` 默认 allow。本项目不得据此宣称 Harness 天生对所有工具 default-deny，也不得把默认继续路径当作保护。

### 复用范围

阶段 3 复用阶段 1/2 已验证的 Simulator、Services、工具 schema 与最小 stub，只把生产路径中的最小 stub 替换为真实本地业务工具。不得重写 Harness Agent Loop，不得改变服务层业务语义，也不得用另一条 Simulator 旁路绕开这些接口。

### 运行约束

技术栈固定为 TypeScript 单栈、单进程、串行执行。真实模型不可用时为 BLOCKED；外部模型不可用不是“阶段完成”，也不能用脚本模型结果冒充真实 E2E。官方工具与 SAFETY 文档只作参考，本机结论仍以锁定版本和实际运行证据为准。

## 修改范围


Stage 3 原始基线实现范围仅允许增加或调整以下内容；实际状态见 [执行进度与计划调整](./execution-progress.md)：

- Harness 启动、配置和锁定版本适配；
- RobotOps 七工具注册、输入输出边界与策略前置检查；
- 真实 Services 调用适配，以及 stub 与生产路径的明确隔离；
- 原生事件与项目业务事件的关联记录；
- 白名单、串行、错误、状态读取和 Happy Path 的集成/E2E 测试。

计划范围外禁止修改：Harness 原生 Agent Loop、Simulator 核心语义、公开工具集合、UI、持久化数据库、HTTP 服务、多 Agent 或真实机器人接入。若锁定 API 与方案冲突，或需要改变公共 API、数据库或安全边界，立即停止并升级，不自行设计替代方案。

## 实现约束

### 唯一工具与执行边界

模型只能看到以下七个工具，不得新增、动态加载或暴露别名：

```text
get_robot_status
get_task_status
search_sop
restart_navigation
force_reboot
resume_task
create_maintenance_ticket
```

禁止向模型暴露 shell、文件写入、通用代码执行、包安装、动态模块加载、网络请求原语或第二条 Simulator 旁路。所有生产调用必须依次经过工具校验、策略检查、Services 和 Simulator。

### 串行和身份边界

同一 run 的模型工具请求必须由宿主串行准入，禁止并行工具请求绕过串行上限。通过并发发送两个写请求的负例证明只准入一个，另一个被拒绝或排队，且 Simulator 只出现一次执行。

`run_id`、`session_id`、`call_id` 由可信宿主生成并注入，模型不能提供或替换。模型不得提供授权、审批者身份、审批结果或安全计数。原生 Session 只维护模型上下文，不等同于项目业务状态持久化；机器人与任务状态始终从 Services/Simulator 的真实状态读取。

每 run 的 20 次模型请求包含 SDK/Provider 实际发生的自动重试；阶段 0 必须能观察并限制该计数，否则关闭自动重试或将阶段标为 BLOCKED。30 次工具调用包含拒绝和无效请求，不能只统计成功调用；实际动作上限独立单计，不再另造调度器。

### 工具结果契约

所有业务工具结果严格包含四个字段：

```text
status
error_code
reason
data
```

`status` 只能是：

```text
SUCCESS
RETRYABLE_FAILURE
FATAL_FAILURE
DENIED
```

输入按锁定 schema 在 handler 前校验；失败时 fail-closed，不进入 handler 或业务路径。输出在 handler 返回后按 schema 校验；失败时记录协议/输出校验错误，保留已经发生的动作事实和真实状态，不得把动作标为未执行、伪造 `SUCCESS` 或自动重放副作用。原生协议错误、网络失败与业务失败必须分开分类和记录；它们不得被改写成 `SUCCESS`，也不得用模型摘要补造结果。

### force_reboot 默认拒绝

`force_reboot` 从第一次注册起即为 Protected Action。原生 `tools/pre-execute` 的 `next()` 默认 allow 不是保护；无论原生路径继续、返回默认值还是使用一次性 `ask`，项目都必须显式安装自己的默认拒绝策略与七工具白名单。项目策略必须在任何原生 continuation 进入 handler、Services 或 Simulator 前完成拒绝决定，并且该策略必须先于保护动作对模型可见而安装完成。

阶段 3 即使只做 Happy Path，也必须测试无有效授权时 `force_reboot` 返回 `DENIED`，handler 未进入，Simulator 状态和执行计数不变化。模型自行传入 `approved=true` 或类似字段一律无效；缺失审批通道也必须拒绝，不能假设 Harness 默认拒绝。

### 状态验证与 Trace

每次关键写操作后必须重新读取真实状态。阶段 3 Happy Path 中，`restart_navigation` 首次实际成功后，必须读取机器人状态确认对应变化；不能仅依据工具返回、模型宣称或会话文字判定成功。

原生 Session/Trace 与项目业务事件按宿主提供的 `run_id` 关联，每个工具请求拥有独立 `call_id`。状态变化事件必须关联实际执行的写调用；动作后的验证读取拥有自己的新 `call_id`，不能与写调用共享。利用串行事件顺序把写后验证与此前动作关联，无需新增复杂追踪接口。临时 stub 必须可识别，不得作为生产集成成果或 E2E 成功证据。

## 验证命令

### 基线验收接口与当前执行状态

以下保留架构约束定义的固定验收接口，并列出当前实际结果：

| 命令 | 当前证据 | 结果 |
|---|---|---|
| `npm run typecheck` | [log](../evidence/verification/prompt-v2-live-20260926T191229/typecheck.log) | PASS |
| `npm run lint` | [log](../evidence/verification/prompt-v2-live-20260926T191229/lint.log) | PASS |
| `npm run test:unit` | [log](../evidence/verification/prompt-v2-live-20260926T191229/test-unit.log) | `164/164/0/0` PASS |
| `npm run test:integration` | [log](../evidence/verification/stage2-5-20260926T183558-905452/test-integration.log) | 十组合 PASS；历史全量 154 tests |
| `npm run test:e2e` | [log](../evidence/verification/stage3-live-20260926T183729/e2e.log) | live PASS；scripted，不是 manual |
### 必需断言

| 验证项 | 诱发条件 | 必须实际断言 |
| --- | --- | --- |
| 工具白名单 | 列出注册工具并调用未知名 | 只存在七工具；未知工具不进入 handler 或 Services |
| 输入校验 | 缺失、非法或额外参数 | 在 handler 前 fail-closed，不进入业务路径，也不返回成功 |
| 输出 schema 失败 | 让 handler 实际返回非法输出 | 记录协议/输出校验错误；保留已经发生的动作事实和真实状态；不标未执行、不假成功、不自动重放副作用 |
| 真实工具调用 | 调用 `get_robot_status`、`search_sop` | 调用经过 Services/Simulator，返回值来自真实执行 |
| runtime 异常映射 | 让 Service 或适配层抛出异常 | 原生协议/网络/runtime 分类与业务结果分离记录，不伪造成 `SUCCESS` |
| 项目默认拒绝不依赖原生默认值 | 让原生 pre-execute 按默认 `next()` 继续，同时无授权调用 `force_reboot` | 项目白名单与默认拒绝仍在 handler 前返回 `DENIED`；Simulator 无副作用 |
| 串行上限 | 并发提交两个写工具请求 | 宿主只准入一个，串行计数和 Simulator 执行计数均为 1 |
| 状态读取关联事件 | 写调用后执行一次验证读取 | Trace 与项目事件同属一个 `run_id`；状态变化关联写调用；验证读取有自己的新 `call_id`，并通过串行事件顺序确认发生在该写调用之后 |
| Happy Path | 真实模型、真实工具、初次 restart 成功 | 动作后重新读状态确认变化；证据不是模型摘要或临时 stub |

Happy Path 必须使用真实模型和真实本地业务工具；若模型不可用，保留阻塞证据并将阶段标为 BLOCKED，不执行或伪造 E2E。

## 完成标准

阶段 3 只有在以下证据全部成立时才算完成：

1. 阶段 0 硬门禁证据可复核，实际包版本和 API 签名已锁定；
2. 生产路径仅暴露七个工具，未出现 shell、文件写入、通用代码执行、动态加载或 Simulator 旁路；
3. 项目白名单、输入/输出校验、真实工具调用、runtime 异常映射、项目默认拒绝不依赖原生默认值、串行限制和状态事件关联测试全部通过；
4. Happy Path 由真实模型完成：首次 `restart_navigation` 实际成功，随后真实读取状态并确认变化；
5. 原始 Trace、工具结果和状态证据互相一致，临时 stub 未作为生产结果；
6. 所有未验证项明确标注，未运行测试不写成通过。

真实模型不可用、阶段 0 未真实验证、只有 stub 或只有模型摘要时，阶段 3 均未完成。

## 失败时如何处理

| 失败类型 | 处理 |
| --- | --- |
| 锁定版本与源码/类型不一致 | 停止实现，记录证据并升级；不得猜 API、改契约或绕过原生 Loop |
| 原生协议、网络或 runtime 错误 | 与业务失败分开记录，fail-closed；不得转换为成功，不得据此自动重放副作用 |
| 输入 schema 或工具白名单校验失败 | 在 handler 前拒绝，保留原始错误分类，Simulator 不得变化 |
| 输出 schema 校验失败 | 保留已发生的动作事实和真实状态，记录协议/输出校验错误；不得标未执行、假成功或自动重放副作用 |
| 无有效授权的 `force_reboot`，或原生 pre-execute 默认继续 | 项目策略返回 `DENIED`，不进入 handler，不执行机器人动作；缺失审批通道同样拒绝 |
| 模型不可用或真实 E2E 不能运行 | 标记 BLOCKED，保留未验证证据；不得以外部阻塞宣称完成 |
| 集成测试或 Trace 关联失败 | 修复当前实现并重跑全部指定命令；无法消除时报告未解决项，不宣称通过 |
| 需要改变公共 API、数据模型或安全边界 | 立即停止并升级到主 Agent；执行层不得自行决策 |

阶段 3 完成后停止，不提前执行阶段 4 的失败恢复与人工审批验收。


