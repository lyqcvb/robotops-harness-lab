# Stage 1 实施报告：机器人模拟器

> 状态：`DONE`。本报告只记录原始日志支持的 Stage 1 验收事实，并区分机器验证与 API 边界核对。状态入口见 [执行进度与计划调整](./execution-progress.md)，跨阶段规则见 [架构约束](./architecture.md)。

## 实现范围

Stage 1 已实现的业务路径：

| 路径 | 范围 |
|---|---|
| `src/contracts/business.ts` | 业务常量、核心 fixture、故障序列、七工具名称、机器人与任务状态类型 |
| `src/trace/business-trace.ts` | 业务 Trace、事件序号、调用关联、不可覆盖记录边界 |
| `src/simulator/robot-simulator.ts` | 机器人/任务快照、三动作、故障序列消费、状态迁移与 run 重置 |
| `tests/business/trace.test.ts` | 业务常量、Trace、session 绑定和 JSON 兼容性测试 |
| `tests/business/simulator.test.ts` | Fixture、六态五态、动作、序列、重置与只读边界测试 |

Stage 1 覆盖并经原始 unit 证据验证的行为包括：

- 新增核心 fixture：`R-03 = ERROR / NAV_042 / battery=31 / TASK-502`，`TASK-502 = PAUSED`。
- 机器人六态：`IDLE / MOVING / ERROR / REBOOTING / CHARGING / OFFLINE`。
- 任务五态：`PENDING / RUNNING / PAUSED / FAILED / COMPLETED`。
- 三动作：`restart_navigation`、`force_reboot`、`resume_task`。
- 故障序列按实际执行逐项消费，耗尽显式失败；拦截不消费。
- 每次 run 重置状态、计数、游标和 Trace，同时保持 run 隔离。
- 查询与快照为只读，不暴露可变内部引用，不把查询计作恢复动作。
- Trace 保留 `run_id`、事件序号、`call_id` 关联和事件顺序；纯 unit 事件使用 `session=null`。

## 原始证据

证据目录：`evidence/verification/stage1-20260926T174638-ebd46b22`。

| 日志 | 命令原文 | 记录结果 |
|---|---|---|
| [`typecheck.log`](../evidence/verification/stage1-20260926T174638-ebd46b22/typecheck.log) | `npm run typecheck` | `tsc --noEmit` 成功，无错误输出 |
| [`lint.log`](../evidence/verification/stage1-20260926T174638-ebd46b22/lint.log) | `npm run lint` | `eslint src scripts tests --max-warnings=0` 成功，无错误输出 |
| [`unit.log`](../evidence/verification/stage1-20260926T174638-ebd46b22/unit.log) | `npm run test:unit` | `64 tests / 64 pass / 0 fail / 0 skip / 0 cancelled / 0 todo` |

`unit.log` 的 `64` 个测试包含 Stage 0 历史测试和 Stage 1 Simulator/Trace 测试；不能把全部 64 个测试都归因于 Stage 1。Stage 1 相关测试文件为 [`tests/business/trace.test.ts`](../tests/business/trace.test.ts) 与 [`tests/business/simulator.test.ts`](../tests/business/simulator.test.ts)。

## API 边界核对

本轮 API 边界核对覆盖业务契约、Trace 事件关联、Simulator 动作边界、只读快照、故障序列消费和 run 重置；当前未发现与已批准架构约束冲突的边界问题。该核对不声明主 Agent 复审，也不替代后续阶段验收；原始证据目录只包含 `typecheck.log`、`lint.log`、`unit.log`，没有独立 API 复审日志。

## 边界与未覆盖项

- Stage 1 是**纯 unit** 验收，没有 live 模型、真实 Harness Session、网络调用、真实人工审批或 E2E。
- 纯 unit Trace 的 `session=null`；不得把该结果写成 live、真实 session 或完整 Harness 集成。
- Stage 1 不包含 Services、ToolBoundary、ApprovalLedger、Harness 业务运行时、真实人审、五场景 live Eval、manual Demo、clean-room 或 Stage 7 交付结论。
- Stage 1 `PASS` 不能替代 Stage 2..7 的验收；Stage 2..5 当时为 `IN_PROGRESS`，Stage 6..7 当时为 `PLANNED`。（2026-10-06 更正：Stage 2–7 现已全部 `DONE`，见 [架构约束](./architecture.md) 的阶段状态表与 [文档导航的「当前状态」](./README.md)。）
