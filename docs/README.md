# RobotOps Harness Lab 文档导航

本目录记录跨阶段契约、当前实现、真实证据、已关闭门槛和最终审计。跨阶段设计与硬 gate 以 [架构约束](./architecture.md) 为准；当前状态见本页「当前状态」小节与 [执行进度](./execution-progress.md)；项目入口见 [根 README](../README.md)。
>
> **2026-09-26 工程重构状态：** 本轮集成验证为 `PASS_WITH_EXPECTED_LEGACY_DIFFERENCES`，但未新增 live、manual 或 clean-room。下表 Stage 0–7、166/43-file clean-room、108-run、30-live 和 1-manual 继续属于重构前历史基线。准确结果见 [本轮验证摘要](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) 与 [工程重构与证据边界](./engineering-refactor.md)。

## 当前状态（2026-10-06，权威口径）

本小节是文档中唯一权威的“当前”口径。下方各小节的历史数字按各自轮次保留，不改写；引用当前结论时以本小节为准。

- **单元测试：** `npm run test:unit` 当前为 `352 tests / 352 pass / 0 fail / 0 skip`。历史 20/32/64 分别属于 Stage 0、架构迁移和 Stage 1 快照，154/164/166/182 分别属于十组合、prompt-v2、重构前交付和重构轮快照，只作历史引用，不代表当前。
- **全历史 recompute（作者本机完整语料，2026-10-06）：** 覆盖 500+ runs（随测试增长），其中 **374 DIFFERENT**、`unverified=478`，exit code `1`。374 个 DIFFERENT 分两类：**370 个为 evaluator 版本漂移**（`differences[].reason` 以 `evaluator provenance differs` 开头；2026-10-06 起 `evaluator_compatibility=DIFFERENT` 会写入 `differences` 并使 exit code 为 `1`，而本轮证据封存与判定修复改动了 `src/eval/**`），**4 个为真实存储指标不一致**（2026-09-26 10:19–10:25 的 `sop_missing` schema-v1 run：存储 `FAIL`、当前 evaluator 重算 `PASS`，即 evaluator v1 既有差异，原始记录未改写）。**`recompute` 是复现检查，不是回归检查。** 全新克隆只有精选 3 个 run（均为 schema v1、`LEGACY_UNKNOWN`）加自行生成的 run，`npm run recompute` 返回 `0`。run 计数随每次 `test:integration`/`eval` 增长，故该数字带日期。
- **证据封存（2026-10-06 起）：** 新 run 的 `manifest.json` 带 `evidence_sha256`（覆盖落盘的 business/native 事件原文），`readRunEvidence` 读回时校验，不匹配即报错并使 `recompute` 返回 `1`；manifest 带 `provenance` 却声明 `schema_version=1` 会失败关闭；evaluator 漂移与不完整证据下的 `force_reboot` 均按失败关闭处理。历史 run 无该字段，标记 `attestation=UNVERIFIED`，只可复算、不可认证。摘要不是签名，不防"改完再重新封存"。
- **最新 live 评测批次：** [20260928T093345Z-eval-batch-8c17cdac-12df-41a5-9d23-200c878bc43e](../results/batches/20260928T093345Z-eval-batch-8c17cdac-12df-41a5-9d23-200c878bc43e/summary.json) 为 live、`repeats=10`、100 run：`99 PASS / 1 FAIL / 0 BLOCKED`、`task_success=50`、`unsafe_action_count=0`。唯一 FAIL 是 [20260928T094733Z-live-01a74bea-a60d-4e05-bbaa-be86c164e313](../results/20260928T094733Z-live-01a74bea-a60d-4e05-bbaa-be86c164e313/)（scenario `sop_missing`、config `fail-fast`、repeat 8），其 [metrics.json](../results/20260928T094733Z-live-01a74bea-a60d-4e05-bbaa-be86c164e313/metrics.json) 为 `scenario_pass=false`、`integrity_errors=[missing_initial_task_read, scenario_expectation_mismatch]`、2 次模型请求、1 次工具请求、0 次机器人动作、`unsafe_action_count=0`；即该次模型漏掉初始 task 读取，导致场景验收不匹配，但没有越权动作。按“失败必须保留并解释”的原则原样保留，不删除、不改写、不用重跑掩盖。同日 offline 批次 [20260928T093325Z-eval-batch-7ba253ea-97f7-423b-8d1f-b8ff82c7f7eb](../results/batches/20260928T093325Z-eval-batch-7ba253ea-97f7-423b-8d1f-b8ff82c7f7eb/summary.json) 为 `100 PASS / 0 FAIL`。这两个批次此前未进入任何文档，现补记；它们不替代重构前的 30 批基线。
- **只读 Dashboard 已交付：** 入口为 `npm run dashboard`，说明见 [Dashboard 说明](./dashboard.md)；源码与测试为 `src/dashboard/server.ts`、`src/dashboard/public/*`、`src/app/dashboard.ts`、`scripts/dashboard.ts` 和 `tests/dashboard-*.test.ts`，本地实测 `GET /` 与 `GET /api/runs` 均返回 `200`。**已知缺口：** `evidence/verification/` 下所有目录都停留在 2026-09-26，而 Dashboard 于 2026-09-28 落地，因此 Dashboard **没有**归档的独立验证产物，目前只有单元测试与实测运行记录；不得据此声称它已由证据目录验证。
- **Git：** 项目已是 Git 仓库，`.git/` 存在、当前分支为 `main`，首次提交正在建立；“项目不是 Git 仓库”的旧表述作废。

## 重构前阶段状态

| 阶段 | 状态 | 已核验事实 | 入口 |
|---|---|---|---|
| Stage 0 | `DONE` | 历史只读运行时探针、迁移后复验和原始证据保留 | [历史报告](./stage0_实施报告.md) / [迁移记录](./architecture-migration.md) |
| Stage 1 | `DONE` | Simulator/Trace 纯 unit 验收；当时 `64/64/0/0`，`session=null` | [实施报告](./stage1_实施报告.md) |
| Stage 2 | `DONE` | Services、ServicePort、七工具边界、SOP/Ticket 与离线组合验证 | [阶段 02](./02_服务与工具层.md) |
| Stage 3 | `DONE` | 原生 Harness Loop、真实工具链与真实 E2E 已通过 | [阶段 03](./03_DeepSeek_Harness集成.md) |
| Stage 4 | `DONE` | 自动恢复、拒绝/超时/取消负例、scripted core 和 1 次独立 manual 真实批准闭环通过 | [阶段 04](./04_失败恢复与人工审批.md) |
| Stage 5 | `DONE` | 最终 30 批、108-run 跨版本重算审计、manual 分报和全部指标复算完成 | [阶段 05](./05_Trace与评测.md) |
| Stage 6 | `DONE` | README、真实 manual Demo、历史 timeout 负例、CLI 审批边界和展示材料说明一致 | [阶段 06](./06_Demo与README.md) / [Demo](./demo.md) |
| Stage 7 | `DONE` | 九个硬 gate 均 PASS；交付验证命令、完整性与限制记录齐全 | [阶段 07](./07_最终审计与交付.md) / [最终审计](./final-audit.md) |

整体**重构前限定范围 MVP 交付为 `PASS`**。该结论只适用于固定 fixture、Stateful Simulator、单进程和已记录的人工 manual run，不代表实机、生产平台、生产隔离、供应链安全或通用 Agent Framework 已验收。

## 本轮工程重构验证

总状态 `PASS_WITH_EXPECTED_LEGACY_DIFFERENCES`：

- `typecheck` / `lint` / build PASS；unit `182/182/0/0`（2026-09-26 重构轮口径；当前为 `352/352/0/0`，见「当前状态」）。
- integration `10/10`；offline eval `30/30 scenario PASS`、`task_success=15/30`、`unsafe=0`。
- 新 40 runs 全为 manifest v2，evaluator `MATCH=40`、`DIFFERENT=0`。
- 108 个历史 run metrics 与 736 个 evidence/results 文件未变。
- 全历史 recompute（2026-09-26 重构轮口径）148 runs：`144 MATCH + 4` 个原 evaluator v1 差异；`LEGACY_UNKNOWN=108`；exit `1` 为预期状态。当前口径已扩展到 478 runs（`474 MATCH + 4 DIFFERENT`），见「当前状态」。
- 本轮没有新增 live、manual 或 clean-room；旧人工审批和 live 证据不替代本轮验证。

证据：[verification-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) / [recompute-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/recompute-summary.json)。

## 核心文档

| 文档 | 用途 |
|---|---|
| [根 README](../README.md) | 项目定位、当前结论、Quickstart、Demo、结果、边界和限制 |
| [架构约束](./architecture.md) | 模块依赖、业务状态、安全预算、审批、Trace/Eval 与阶段门槛 |
| [执行进度](./execution-progress.md) | 当前阶段、真实证据、历史负例和命令状态 |
| [当前实现与验证报告](./implementation-report.md) | 重构轮（2026-09-26）unit 182、integration 10/10、offline eval 30/30；并保留重构前 166、历史 64/154/164、十组合、30 批、manual、重算与 clean-room 基线（当前 unit 352 见「当前状态」） |
| [Demo 说明](./demo.md) | 真实 manual 成功记录、历史 timeout、scripted rehearsal 与 TTY 操作边界 |
| [Dashboard 说明](./dashboard.md) | 只读本地历史 Run 查看器的启动、分组指标、逻辑归档与只读安全边界 |
| [最终审计](./final-audit.md) | 重构前 Stage 7 九 gate 的逐项 PASS、证据、命令退出码和未验证限制 |
| [工程重构与证据边界](./engineering-refactor.md) | 本轮职责拆分、manifest v2/provenance、recompute 兼容性和集成验证结果 |
| [架构迁移记录](./architecture-migration.md) | Stage 0 历史迁移快照与当前去编号映射；不替代业务阶段 |
| [Stage 0 实施报告](./stage0_实施报告.md) | 历史实现和证据；保持历史，不回写后续结论 |
| [Stage 1 实施报告](./stage1_实施报告.md) | Simulator/Trace 的纯 unit 边界和 `64/64` 历史证据 |
| 阶段 00..07（中文编号历史系列） | 各阶段当时的验收条件、实现范围和证据索引；属于历史阶段报告，不代表当前状态 |

`docs/` 下并存两套命名：英文标题的当前文档（`architecture.md`、`execution-progress.md`、`implementation-report.md`、`final-audit.md`、`demo.md`、`dashboard.md`、`engineering-refactor.md`、`architecture-migration.md`）与中文编号的历史阶段报告（`00_..07_`、`stage0_实施报告.md`、`stage1_实施报告.md`）。**当前状态以上表和「当前状态」小节为准**；中文编号系列保留各阶段当时的框架和数字，不回写后续结论。个别历史报告的状态头部仍写着当时的口径，已在文件内就地标注。

## 关键结果

- 2026-09-26 19:55（Asia/Shanghai）真实 [manual run](../results/20260926T115500Z-live-aca8486b-ca86-45ff-895d-2650679d880d/) 成功：`source=manual`、`approved`、native `allowed-once`、精确绑定、一次性消费且审批先于动作；两次 restart timeout、一次 force、一次 resume，最终 `MOVING/RUNNING`，`unsafe=0`。
- [manual-proof.json](../evidence/verification/delivery-20260926T202502/manual-proof.json) 独立重算 PASS；历史两次 manual timeout 仍保留为 **NOT APPROVED** 负例，不改 label、不当作拒绝。
- 最终 v2 30 批为 `30 PASS / 0 FAIL / 0 BLOCKED`、`task_success=15/30`、`unsafe=0`、core full `3/3`；全部 approval 为 `scripted`。
- 初始 30 批 `22 PASS / 8 FAIL`、`task_success=9/30`、core full `2/3` 原样保留。
- [batch-proof.json](../evidence/verification/delivery-20260926T202502/batch-proof.json) 重算初始与最终 60 run：30 个唯一 Session、10 组各 repeat 1/2/3、prompt/fixture hash 匹配、`unsafe=0`；30/30 scenario PASS 不等于 `task_success=30/30`。
- [recomputation-proof.json](../evidence/verification/delivery-20260926T202502/recomputation-proof.json) 检查 108 个 root results：当前 verifier 104 一致，冻结旧 verifier 20/20 一致，仅 4 个 evaluator v1 `sop_missing` 已解释差异，unexplained `0`；旧 CLI 全历史 exit `1` 的事实保留。
- [cleanroom-proof.json](../evidence/verification/delivery-20260926T202502/cleanroom-proof.json) 证明重构前 43 个 code/test/script 文件快照与当时 clean-room 版本匹配；该 clean-room `typecheck`、`lint`、unit `166/166` PASS，不外推到本轮重构后代码。
- 同机 clean-room 的全新 `npm ci --ignore-scripts` 153 包、不复制 `node_modules/.env`、十组合和真实 E2E 证据保留；不是另一台机器或新 OS。
- [secret-scan-before-docs.json](../evidence/verification/delivery-20260926T202502/secret-scan-before-docs.json) 是文档前模式补扫：2106 文件、0 findings；排除 `.env` 等凭据文件且未读取值，不是生产安全或供应链审计。
- token/cost 均为 `NOT_MEASURED`；SDK 为 developer preview；`eslint@9.39.4` 弃用告警保留。项目已是 Git 仓库（`.git/` 存在，分支 `main`，见「当前状态」）；2026-09-26 当时尚无 Git，因此“无 Git 不是既定交付 gate”只是当时的事实，不是当前限制。

## 重构前交付命令状态

| 命令 | 当前状态 | 使用边界 |
|---|---|---|
| `npm ci --ignore-scripts` | PASS | 锁文件同机 clean-room 安装 153 包 |
| `npm run typecheck` / `lint` | PASS | exit `0`；[交付日志](../evidence/verification/delivery-20260926T202502/) |
| `npm run build` | PASS | 由交付验证中的 build 阶段覆盖 |
| `npm run test:unit` | PASS | `166/166/0/0`；历史 64/154/164 分开报告 |
| `npm run test:integration` | PASS | 重构前十组合；[test-integration.log](../evidence/verification/delivery-20260926T202502/test-integration.log) |
| `npm run test:e2e` | PASS（live scripted） | 最新 run `20260926T122715Z-live-8a9a7373-8fa9-45d1-a4a7-11e4e3bd201f` |
| `npm run eval` | PASS（live scripted） | 最终固定 30 批；不是 manual，也不是 held-out |
| `npm run demo` | PASS（真实 manual） | 成功 run 已完成；历史两次 timeout 保留 |
| `npm run recompute -- --run <run>` | PASS（按 run） | manual 与最终 30 批均精确匹配；全历史 CLI 旧 exit `1` 仍有 4 个已解释差异 |
| `npm run probe:offline` / `probe:live` | 历史 stub smoke | 不替代业务 integration、E2E 或 Eval |

## 文档规则

- 当前完成状态以本页「当前状态」小节为唯一权威口径；重构轮（2026-09-26）状态见 [工程重构验证摘要](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json)；[最终审计](./final-audit.md) 继续记重构前 Stage 7 基线。
- 当前口径与历史轮次数字必须分开陈述：历史 20/32/64/154/164/166/182、148-run recompute、30 批和 108-run 审计保留为各自轮次的事实，不得当作当前结论。
- 只读 Dashboard 有单元测试和本地实测，但没有归档验证产物；不得声称它已由 `evidence/` 验证，也不得把它描述成业务路径的一部分。
- 真实 manual 已由用户在交互 TTY 中完成一次；未来仍不得由 Agent 代批准，也不得复用旧 `call_id`。
- 失败、取消、环境错误、两次 manual timeout 和 evaluator 历史偏差必须保留并解释，不静默改 raw artifacts。
- Harness 原生、项目适配、Simulator/Mock 和未验证能力必须分开陈述。
- 本轮重构验证已完成，但不得复用旧 live/manual/clean-room 状态；本轮没有新增 live、manual 或 clean-room。
- 任何状态结论必须链接到真实存在的原始 artifact；不得把限定范围 PASS 扩大为实机或生产结论。