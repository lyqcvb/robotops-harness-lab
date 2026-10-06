# Stage 0 架构迁移与复验记录

> 日期：2026-09-26
>
> 状态：Stage 0 分层迁移与主 Agent 统一复验已完成。Stage 1..7、业务 Simulator/Services、业务 E2E 与 Eval 仍为 `PLANNED`。
>
> **2026-10-06 当前状态（更正）：** Stage 0–7 现均为 `DONE`；`test:e2e` 与 `eval` 均已实现并有真实运行证据，不再是 `PLANNED` 占位。当前口径以 [文档导航的「当前状态」](./README.md) 与 [架构约束](./architecture.md) 为准，本行只描述迁移当时的状态。
>
> 本文记录迁移验收，不新增业务或安全契约，不替代 [架构约束](./architecture.md)，也不是全面安全审计、性能证明或生产隔离证明。
>
> **历史快照：** 以下“迁移范围/验证结果/当前证据”记录当时状态；文中的旧源码路径、Stage 状态和验证结论不代表当前目录结构或当前阶段状态。当前架构约束见 [architecture.md](./architecture.md)，当前代码组织见 [根 README](../README.md)。
>
> **当前去编号映射：** 本节只记录后续路径迁移，不改变 npm 命令名、业务与证据协议。迁移后 CLI 命令名仍为 `probe:offline` / `probe:live`，底层入口改为 `build/scripts/probe.js`；公共业务模块、API/权限边界、数据格式以及 `evidence/stage0/`、`.stage0/` 路径协议均保持不变。

| 迁移前（仅历史代码文字） | 当前路径 |
|---|---|
| `src/contracts/stage0/acceptance.ts` | `src/contracts/probe-acceptance.ts` |
| `src/contracts/stage0/constants.ts` | `src/contracts/probe-constants.ts` |
| `src/contracts/stage0/evidence.ts` | `src/contracts/probe-evidence.ts` |
| `src/contracts/stage0/probe.ts` | `src/contracts/probe.ts` |
| `src/harness/stage0/probe-runtime.ts` | `src/harness/probe-runtime.ts` |
| `src/harness/stage0/scripted-adapter.ts` | `src/harness/scripted-adapter.ts` |
| `src/harness/stage0/scenarios.ts` | `src/harness/probe-scenarios.ts` |
| `src/trace/stage0/evidence.ts` | `src/trace/probe-evidence.ts` |
| `src/eval/stage0/acceptance.ts` | `src/eval/probe-acceptance.ts` |
| `src/eval/stage0/report.ts` | `src/eval/probe-report.ts` |
| `src/app/stage0/probe.ts` | `src/app/probe.ts` |
| `scripts/stage0/probe.ts` | `scripts/probe.ts` |
| `tests/stage0/*.test.ts` | `tests/probe/*.test.ts` |
| `scripts/stage0/not-implemented.mjs` | 已移除（原文件无引用） |

## 迁移范围

- CLI 保持 `scripts/stage0/probe.ts` 作为唯一入口。
- Stage 0 编排迁至 `src/app/stage0/probe.ts`。
- 中立类型、常量与契约迁至 `src/contracts/stage0/`。
- 原生运行时保护、脚本适配与默认场景迁至 `src/harness/stage0/`。
- 项目证据与脱敏导出迁至 `src/trace/stage0/evidence.ts`。
- 独立验收与汇总迁至 `src/eval/stage0/`。
- 旧 `src/stage0` 路径删除，不保留兼容入口；本文件只以代码文字提及旧路径，不提供失效链接。
- 依赖保持单向：contracts 不依赖项目上层/SDK；trace 依赖 contracts；harness 依赖 contracts/trace；eval 依赖 contracts/trace 且不依赖 harness；app 组装；scripts 只依赖 app；`src` 不依赖 scripts/tests 且无环。
| 旧模块（仅代码文字） | 新分层 | 迁移说明 |
|---|---|---|
| `src/stage0/probe-runtime.ts`、`src/stage0/scripted-adapter.ts` | `src/harness/stage0/` | 原生运行时保护、脚本适配与默认场景 |
| `src/stage0/constants.ts` | `src/contracts/stage0/` | 中立常量与类型 |
| `src/stage0/evidence.ts` | `src/trace/stage0/evidence.ts` | 项目证据与脱敏/导出边界 |
| `src/stage0/acceptance.ts` | `src/eval/stage0/` | 独立验收与汇总 |
| CLI 从脚本内编排 | `src/app/stage0/probe.ts` + `scripts/stage0/probe.ts` | app 负责组装，CLI 只保留入口职责 |

## 验证结果

| 验证项 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | `PASS` | 主 Agent 在迁移后复验 |
| `npm run lint` | `PASS` | 主 Agent 在迁移后复验 |
| `npm run build` | `PASS` | 主 Agent 在迁移后复验 |
| `npm run test:unit` | `PASS` | 32 tests / 32 pass / 0 fail / 0 skip；20 项原有断言 + 12 项新增架构测试 |
| `npm run test:integration` | `PASS` / exit 0 | 主 Agent 执行的唯一一次迁移后 live 复验；Stage 0 smoke，不是业务 E2E |
| offline probe | 9 cases `PASS` | `stage0Complete=false`、live `NOT_RUN`；不单独关闭 Stage 0 live gate |

迁移前后事实核对：

- 66 个原函数体仅存在换行差异，未发现逻辑改动。
- 20 项原测试断言完整保持不变。
- 386 个受保护历史/配置文件逐字节未变；历史 run 不替换、不覆盖。
- `package.json` 仅扩展 `test:unit` 以纳入架构测试；当时未初始化 Git（2026-10-06 现状：已是 Git 仓库，分支 `main`）。

## 当前证据

### 迁移后 live 复验

- run：`20260926T092041Z-live-4a5e61a2-5049-4525-86aa-f75313a93806`
- [summary.json](../evidence/stage0/20260926T092041Z-live-4a5e61a2-5049-4525-86aa-f75313a93806/summary.json)
- [native-events.jsonl](../evidence/stage0/20260926T092041Z-live-4a5e61a2-5049-4525-86aa-f75313a93806/native-events.jsonl)：175 行
- [probe-events.jsonl](../evidence/stage0/20260926T092041Z-live-4a5e61a2-5049-4525-86aa-f75313a93806/probe-events.jsonl)：33 行
- 结果：`status=PASS`、`stage0Complete=true`；`static-versions`、`offline-whitelist`、`offline-safety`、`offline-persistence`、`live-gate` 全部 `PASS`；`blocked=[]`。
- summary schema 字段保持不变；两份 trace 的 `batch_sequence` 分别连续。
- 批次 21 次模型请求 = 19 scripted + 2 真实 Provider 请求。LIVE 子集为 2 次真实模型请求、1 次 `get_robot_status('R-03')` 工具请求/只读 stub 执行、0 次审批。
- 该结果是只读 Stage 0 smoke；不是真人审批、业务恢复或业务 E2E。

### 迁移后独立 offline

- run：`20260926T091515Z-offline-035a5703-33d2-4573-ba4c-c644bc9029ef`
- [summary.json](../evidence/stage0/20260926T091515Z-offline-035a5703-33d2-4573-ba4c-c644bc9029ef/summary.json)
- [native-events.jsonl](../evidence/stage0/20260926T091515Z-offline-035a5703-33d2-4573-ba4c-c644bc9029ef/native-events.jsonl)
- [probe-events.jsonl](../evidence/stage0/20260926T091515Z-offline-035a5703-33d2-4573-ba4c-c644bc9029ef/probe-events.jsonl)
- 结果：执行 Agent 真实执行 9 cases `PASS`、`stage0Complete=false`、live `NOT_RUN`；不把 scripted 请求计为真实模型请求。

历史 run 继续作为基线保留：[迁移前 live 记录](./stage0_实施报告.md) 与 `evidence/stage0/` 下的失败、离线、负例和旧 live 记录均不替换。

## 历史保护与限制

- 本记录只覆盖 Stage 0 的迁移验收与一次复验；没有完成五场景、30 次真实模型实验、真实人工审批或业务恢复。
- `test:e2e` 与 `eval` 当时仍是明确 exit 2 的 `PLANNED` 占位；两者现已实现，见 [架构约束](./architecture.md) 的阶段状态表。
- 没有真实机器人、3D 物理仿真、生产环境或可靠沙箱；不宣称生产隔离、安全审计、供应链审计或统计显著性。
- 历史失败与 `BLOCKED` 负例继续保留，迁移成功不改写旧结论。
