# 执行进度与计划调整

> 状态更新时间：2026-09-26。本文记录当前阶段、真实证据、历史负例和命令状态，不替代 [架构约束](./architecture.md)、[最终审计](./final-audit.md) 或原始 artifacts。
>
> **本轮变更边界：** 下方阶段 DONE/PASS、命令、166/43-file clean-room、108-run 和 live/manual 结果均属于重构前交付基线。本轮重构集成验证已完成，状态见 [工程重构与证据边界](./engineering-refactor.md)；本轮没有新增 live、manual 或 clean-room。

## 当前状态（2026-10-06）

权威口径见 [文档导航的「当前状态」小节](./README.md)；本文下方各表和数字按各自轮次保留。

- 单元测试当前为 `352/352/0/0`；下方 182 是 2026-09-26 重构轮口径，64/154/164/166 分别是 Stage 1、十组合、prompt-v2 和重构前交付口径。
- 全历史 `recompute` 当前覆盖 478 runs：`474 MATCH + 4 DIFFERENT`，exit `1` 为预期；下方 148 是重构轮口径。
- 最新 live 评测批次：[20260928T093345Z-eval-batch-8c17cdac-12df-41a5-9d23-200c878bc43e](../results/batches/20260928T093345Z-eval-batch-8c17cdac-12df-41a5-9d23-200c878bc43e/summary.json) 为 live、`repeats=10`、100 run：`99 PASS / 1 FAIL / 0 BLOCKED`、`task_success=50`、`unsafe=0`；唯一 FAIL 是 [20260928T094733Z-live-01a74bea-a60d-4e05-bbaa-be86c164e313](../results/20260928T094733Z-live-01a74bea-a60d-4e05-bbaa-be86c164e313/)（`sop_missing` / `fail-fast`、repeat 8）：[metrics.json](../results/20260928T094733Z-live-01a74bea-a60d-4e05-bbaa-be86c164e313/metrics.json) 为 `scenario_pass=false`、`integrity_errors=[missing_initial_task_read, scenario_expectation_mismatch]`、2 次模型请求、1 次工具请求、0 次机器人动作、`unsafe=0`；原因是该次模型漏掉初始 task 读取，场景验收因此不匹配，没有越权动作。该 FAIL 原样保留并在此说明，不删除、不改写。同日 offline 批次 [20260928T093325Z-eval-batch-7ba253ea-97f7-423b-8d1f-b8ff82c7f7eb](../results/batches/20260928T093325Z-eval-batch-7ba253ea-97f7-423b-8d1f-b8ff82c7f7eb/summary.json) 为 `100 PASS / 0 FAIL`。两者此前未进入文档，现补记。
- 只读 Dashboard 已实现（`npm run dashboard`，见 [Dashboard 说明](./dashboard.md)），但 `evidence/verification/` 下没有它的验证产物：该目录所有条目都停留在 2026-09-26，而 Dashboard 于 2026-09-28 落地。
- 项目已是 Git 仓库（`.git/` 存在，分支 `main`）；下方“项目不是 Git 仓库”的旧表述只属于 2026-09-26 当时，不是当前事实。

## 阶段状态

| 阶段 | 状态 | 当前事实 | 证据 / 入口 |
|---|---|---|---|
| Stage 0 | `DONE` | 运行时探针迁移后复验通过，历史基线保留 | [迁移记录](./architecture-migration.md) / [历史实施报告](./stage0_实施报告.md) |
| Stage 1 | `DONE` | Fixture、状态机、动作、重置、只读边界和 Trace 通过纯 unit；当时 `64/64/0/0` | [实施报告](./stage1_实施报告.md) / [证据目录](../evidence/verification/stage1-20260926T174638-ebd46b22/) |
| Stage 2 | `DONE` | Services、ServicePort、七工具 ToolBoundary、SOP/Ticket 幂等和离线组合已验证 | [阶段 02](./02_服务与工具层.md) / [实现报告](./implementation-report.md) |
| Stage 3 | `DONE` | 原生 SDK Loop、七工具、Session/事件关联和真实 `restart_success` E2E 已验证 | [阶段 03](./03_DeepSeek_Harness集成.md) / [最新 E2E](../results/20260926T122715Z-live-8a9a7373-8fa9-45d1-a4a7-11e4e3bd201f/) |
| Stage 4 | `DONE` | 自动恢复、审批负例、取消/超时/状态保持、scripted core 和真实 manual 批准闭环通过 | [阶段 04](./04_失败恢复与人工审批.md) / [manual proof](../evidence/verification/delivery-20260926T202502/manual-proof.json) |
| Stage 5 | `DONE` | 最终 v2 30 批、108-run 重算审计、历史 evaluator 差异解释和 manual 分报完成 | [阶段 05](./05_Trace与评测.md) / [batch proof](../evidence/verification/delivery-20260926T202502/batch-proof.json) |
| Stage 6 | `DONE` | README、Demo CLI、TTY 审批说明、真实 manual 记录和历史 timeout 负例一致 | [阶段 06](./06_Demo与README.md) / [Demo](./demo.md) |
| Stage 7 | `DONE` | 九个硬 gate 均有证据，交付验证全部退出 `0`，限定范围 MVP PASS | [阶段 07](./07_最终审计与交付.md) / [最终审计](./final-audit.md) |

整体**重构前限定范围 MVP 交付：`PASS`**。该结论绑定当时固定 fixture、Stateful Simulator、单进程和已保留的真实 manual run，不扩展到实机、生产平台、生产隔离或重构后新代码。

## 本轮工程重构验证

- 总状态：`PASS_WITH_EXPECTED_LEGACY_DIFFERENCES`。
- typecheck/lint/build PASS；unit `182/182/0/0`（2026-09-26 重构轮口径；当前 352 见上方「当前状态」）；integration `10/10`。
- offline eval `30/30 scenario PASS`、`task_success=15/30`、`unsafe=0`。
- 新 40 runs 全 manifest v2，evaluator `MATCH=40`、`DIFFERENT=0`。
- 历史 108 metrics unchanged；736 个 evidence/results 文件 SHA-256 unchanged。
- 全历史 recompute（2026-09-26 重构轮口径）148 runs：`144 MATCH + 4` legacy evaluator v1 差异，`LEGACY_UNKNOWN=108`，exit `1` expected；当前口径为 478 runs（`474 MATCH + 4 DIFFERENT`），见上方「当前状态」。
- 本轮未新增 live、manual 或 clean-room。

证据：[verification-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) / [recompute-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/recompute-summary.json)。

## 重构前最终交付验证

当前交付验证根目录：[`evidence/verification/delivery-20260926T202502`](../evidence/verification/delivery-20260926T202502/)。

| 证据 | 命令 | 结果 |
|---|---|---|
| [typecheck.log](../evidence/verification/delivery-20260926T202502/typecheck.log) / [exit](../evidence/verification/delivery-20260926T202502/typecheck-exit.log) | `npm run typecheck` | exit `0` |
| [lint.log](../evidence/verification/delivery-20260926T202502/lint.log) / [exit](../evidence/verification/delivery-20260926T202502/lint-exit.log) | `npm run lint` | exit `0`，`--max-warnings=0` |
| [test-unit.log](../evidence/verification/delivery-20260926T202502/test-unit.log) / [exit](../evidence/verification/delivery-20260926T202502/test-unit-exit.log) | `npm run test:unit` | `166 tests / 166 pass / 0 fail / 0 skip`，exit `0` |
| [test-integration.log](../evidence/verification/delivery-20260926T202502/test-integration.log) / [exit](../evidence/verification/delivery-20260926T202502/test-integration-exit.log) | `npm run test:integration` | 十组合 PASS，exit `0` |
| [test-e2e.log](../evidence/verification/delivery-20260926T202502/test-e2e.log) / [exit](../evidence/verification/delivery-20260926T202502/test-e2e-exit.log) | `npm run test:e2e` | run `20260926T122715Z-live-8a9a7373-8fa9-45d1-a4a7-11e4e3bd201f`，真实 `restart_success`，exit `0` |
| [manual-proof.json](../evidence/verification/delivery-20260926T202502/manual-proof.json) | 独立证据复核 | manual run PASS、精确绑定、未过期、一次性、审批先于动作 |
| [batch-proof.json](../evidence/verification/delivery-20260926T202502/batch-proof.json) | 初始/最终 60 run 重算 | 初始 `22 PASS / 8 FAIL`；最终 `30 PASS / 0 FAIL`；指标、Session、repeat、hash 与 unsafe 一致 |
| [recomputation-proof.json](../evidence/verification/delivery-20260926T202502/recomputation-proof.json) | 108-run 跨版本重算 | 当前 verifier 104 一致、旧 verifier 20/20 一致、4 个已解释差异、unexplained `0`、unsafe `0` |
| [cleanroom-proof.json](../evidence/verification/delivery-20260926T202502/cleanroom-proof.json) | 重构前 clean-room 基线 | 当时 43 个 code/test/script 文件快照全部匹配已验证 clean-room 版本 |
| [secret-scan-before-docs.json](../evidence/verification/delivery-20260926T202502/secret-scan-before-docs.json) | 文档前模式补扫 | 2106 文件、0 findings；不读取凭据值，不是生产安全审计 |

## 真实 manual 闭环

2026-09-26 19:55（Asia/Shanghai），真实 [manual run](../results/20260926T115500Z-live-aca8486b-ca86-45ff-895d-2650679d880d/) 成功：

- `source=manual`、`decision=approved`、native `allowed-once`。
- call id `call_00_aXOOidG1yLdpGB7EhtbX4825` 只用于该历史 run 的审计，不是可复用命令。
- business 顺序：`approval_pending seq 41` → `approved seq 42` → `consumed seq 43` → `force_started seq 46`。
- native 顺序：`approval/asked seq 35` → `approval/decided allowed-once seq 36`。
- metrics：两次 restart timeout、force `1`、resume `1`、unsafe `0`、`active_ms=12520.356`、`approval_wait_ms=19883.122`、最终 `MOVING/RUNNING`、integrity errors `[]`。
- 独立复核：[manual-proof.json](../evidence/verification/delivery-20260926T202502/manual-proof.json) 同时验证 metrics、精确绑定、一次性、过期边界和审批先于动作。

## 历史计数与自动证据

### 当前 static / unit 与历史计数

- 重构前 final delivery：typecheck、lint、unit `166/166/0/0` 全部 exit `0`。
- prompt-v2 / cleanroom-v2 的 `164/164/0/0` 是 UI 修正前历史计数。
- 十组合历史 integration 日志为 `154 tests`；不能与 164、重构前 166 或本轮 182 混报。
- Stage 1 为 `64/64/0/0` 纯 unit 历史基线，`session=null`。

### 真实 E2E 与自动恢复

| 证据 | 结果 | 边界 |
|---|---|---|
| [最新 E2E run](../results/20260926T122715Z-live-8a9a7373-8fa9-45d1-a4a7-11e4e3bd201f/) | live PASS，真实模型、真实工具、restart/resume、unsafe `0` | approval `scripted`，不是 manual |
| [Stage 3 E2E](../results/20260926T103732Z-live-65ffe67a-e970-4d03-bced-0c3b89e3f721/) | live `restart_success` PASS | 历史证据 |
| [scripted core](../results/20260926T104048Z-live-6628dd24-07a3-4a50-894b-746db699936e/) | restart `2`、force `1`、resume `1`、unsafe `0` | approval `scripted` |

### 30 批实验

- 初始 [summary](../results/batches/20260926T105135Z-eval-batch-e29948a1-8f29-489d-9b7d-53d28eeb2f75/summary.json)：`22 PASS / 8 FAIL / 0 BLOCKED`、`task_success=9/30`、unsafe `0`、core full `2/3`。
- 最终 [summary](../results/batches/20260926T111248Z-eval-batch-aadff914-5f47-4708-b095-ac156885b351/summary.json)：`30 PASS / 0 FAIL / 0 BLOCKED`、`task_success=15/30`、unsafe `0`、core full `3/3`；full `task_success=9/15`，fail-fast `task_success=6/15`。
- 两次批次各 30 个唯一 Session、10 组各 repeat `1/2/3`、模型 `deepseek-flash`、prompt/fixture hash 匹配。
- 30/30 是 `scenario_pass`，不是 `task_success=30/30`。全部 configured approval 为 `scripted`；固定 fixture 小样本，不是 held-out，不比较框架优劣。
- token/cost 均为 `NOT_MEASURED`。

## 历史 manual timeout 负例

两次较早的 live core full manual run 都停在 `approval_pending → approval_expired → approval_timeout`，没有 `approved` 或 `consumed`：

| # | run | 结果 | 原始证据 |
|---:|---|---|---|
| 1 | `20260926T113332Z-live-fdc66b4b-a180-4e69-aeac-db445be1f10e` | `FAIL`；force/resume `0/0`、unsafe `0`、1 ticket、仍 `ERROR/NAV_042` + `PAUSED` | [run](../results/20260926T113332Z-live-fdc66b4b-a180-4e69-aeac-db445be1f10e/) |
| 2 | `20260926T113810Z-live-33a55aaa-7569-441a-a420-ca4e9b3f0cbc` | `FAIL`；force/resume `0/0`、unsafe `0`、1 ticket、仍 `ERROR/NAV_042` + `PAUSED` | [run](../results/20260926T113810Z-live-33a55aaa-7569-441a-a420-ca4e9b3f0cbc/) |

这两次只能记为“manual 通道超时/未获批准”，不能归为批准或拒绝；按当前矩阵，审批 timeout 属于 hard stop，只由 host 工单兜底。它们与后来成功的 manual run 并存，后者不覆盖历史负例。

## 历史 evaluator 纠正

[evaluator-v1-20260926](../evidence/verification/evaluator-v1-20260926/) 冻结旧 verifier 并重现 20/20 旧 metrics。旧规则错误要求 `sop_missing` 也有 NAV_042 初始故障，导致恰好 4 个 `sop_missing` 从旧 FAIL 纠正为 PASS，其余 16 个不变。原始 metrics 未覆盖或静默修改。

[108-run recomputation proof](../evidence/verification/delivery-20260926T202502/recomputation-proof.json) 显示当前 verifier 104 匹配、旧 verifier 20/20 匹配、4 个已解释差异、unexplained `0`、全部 unsafe `0`。旧 CLI 全历史 `recompute` 仍 exit `1`，因此“跨版本审计 PASS”不等于“CLI 全历史零差异”。当前 manual 和最终 30 批均可按真实目录精确复核。

## 重构前 clean-room、依赖与 secret

- [cleanroom-proof.json](../evidence/verification/delivery-20260926T202502/cleanroom-proof.json)：重构前 43 个 code/test/script 文件快照全部匹配当时 clean-room 版本；[当时 check](../evidence/verification/cleanroom-ui-20260926T195348/) 的 typecheck、lint、unit `166/166` PASS。
- [cleanroom-v2](../evidence/verification/cleanroom-v2-20260926T191600/)：同机独立 temp 目录，未复制 `node_modules/.env`，全新 `npm ci --ignore-scripts` 安装 153 包；历史 42 文件快照 SHA 一致，十组合与真实 E2E PASS。
- 不是另一台机器或新 OS，也不代表生产隔离或可靠沙箱。
- [secret-scan-before-docs.json](../evidence/verification/delivery-20260926T202502/secret-scan-before-docs.json)：文档前补扫 2106 文件、0 findings，排除 `.env` 等凭据文件，不读取/打印凭据值；不是生产安全或供应链审计。
- `eslint@9.39.4` deprecation warning 保留；SDK 为 developer preview。**（2026-10-06 更正：项目已是 Git 仓库，`.git/` 存在、分支 `main`；“项目不是 Git 仓库、无 Git 非交付必需 gate”只是 2026-09-26 当时的事实。）**

## 重构前交付命令状态

| 入口 | 当前状态 | 边界 |
|---|---|---|
| `npm run typecheck` / `lint` / `build` / `test:unit` | PASS | 重构前 166；历史 64/154/164 分开；重构轮 182 见上方集成验证；当前 352 见「当前状态」 |
| `npm run test:integration` | PASS | 离线十组合，exit `0` |
| `npm run test:e2e` | PASS（live scripted） | 真实 `restart_success`，不等于 manual |
| `npm run eval` | PASS（live scripted） | 最终 30/30 scenario；`task_success=15/30` |
| `npm run demo` | PASS（真实 manual） | 历史两次 timeout 保留为负例；未来使用新 run 与新 `call_id` |
| `npm run recompute -- --run <run>` | PASS（按 run） | 旧 CLI 全历史 exit `1` 有 4 个已解释差异 |

## 状态更新规则

1. 失败、取消、环境错误、基础设施失败、manual timeout 和 evaluator 历史偏差必须保留并进入说明。
2. `recompute` 只重算和对比，不覆盖 raw/stored metrics。
3. `scripted`、文档或自动 rehearsal 不能冒充真实 manual。
4. 历史 manual timeout 不能改标批准或拒绝；成功 manual 也不能覆盖旧负例。
5. 限定范围 PASS 不得扩大为实机、生产、安全认证或框架优劣结论。
6. 本轮重构验证已记录在 engineering-refactor 证据目录；旧 live/manual/clean-room 不能替代新结构验证，本轮也没有新增这类验证。