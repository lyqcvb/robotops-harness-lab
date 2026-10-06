# 2026-09-26 工程重构与证据边界

> 状态：`PASS_WITH_EXPECTED_LEGACY_DIFFERENCES`。本轮重构已完成集成验证；历史 4 个 evaluator v1 差异仍保留，但没有新增 live、manual 或 clean-room 结论。
>
> **2026-10-06 当前状态：** 本文的 182/148 是 2026-09-26 重构轮口径。当前口径以 [文档导航的「当前状态」](./README.md) 为准：单元测试 `352/352/0/0`、全历史 `recompute` 478 runs（`474 MATCH + 4 DIFFERENT`，exit `1` 仍为预期）。

## 本轮范围与非目标

本轮只做三件事：

1. 重构模块边界，降低单文件编排、运行时、工具和评估器职责耦合。
2. 收敛稳定的运行与证据协议，主要是 run manifest v2 provenance 和 recompute 兼容性诊断。
3. 增强对“Prompt 建议、执行前 hard constraint、事后验收”的区分，避免把场景要求或事后 FAIL 描述成 runtime 已执行的前置阻止。

本轮不改变七工具集合、恢复策略、审批语义、预算上限、人工审批边界或 Stage 0–7 的既定验收范围；不增加 runtime 级的“所有动作必须有历史 SOP”强制门；不新增依赖、权限系统、生产隔离或安全认证承诺；不触发 live、人工审批或其他需要外部人员的验证。

## 版本归因与旧证据边界

Stage 0–7 历史交付结论继续保留，但它们属于本轮工程重构前的交付基线。旧 `live`、`manual`、clean-room、批次和重算证据只证明其原始 run/snapshot，不自动证明重构后的新结构。

| 历史事实 | 版本归属 | 本轮可使用的结论 |
|---|---|---|
| Stage 0–7 均为 `DONE`；限定范围 MVP 交付 `PASS` | 重构前 Stage 7 交付基线 | 历史交付结论继续有效，但不替代重构后重新编译和测试结果 |
| unit `166/166/0/0`、integration 十组合 PASS | 重构前验证基线 | 保留原数值；不得写成本轮新结构已验证 |
| 43 个 code/test/script 文件与 clean-room 匹配 | 重构前文件快照与同机 clean-room 基线 | 只说明当时 43 文件快照；重构后文件集合变化时该等同性自然失效 |
| 108 个 root results 的跨版本重算审计 | 重构前/历史证据审计 | 旧 v1 artifacts 继续兼容读取；历史 4 个 evaluator v1 差异继续保留 |
| 30 批 live scripted 与 1 次独立 manual run | 重构前 run 基线 | 不把旧 live/manual结果冒充重构后新验证；本轮没有新增 manual 结论 |

因此，README、实现报告、执行进度和最终审计中的旧强称应降格为“当时基线事实”。本轮重构后状态统一以 [engineering-refactor-20260926T132019Z 验证摘要](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) 为准（2026-10-06 起，当前口径改以 [文档导航的「当前状态」](./README.md) 为准；本轮的 182/148 仍只属于该轮）。

## SOP 与停止约束分界

完整、唯一的职责矩阵维护在 [架构约束的 SOP、动作前置与停止约束矩阵](./architecture.md#sop动作前置与停止约束矩阵)，其它文档只链接该矩阵，不复制第二份规则。

分类口径固定为：

- **Runtime 运行前硬控制**：进入 handler、Service 或 Simulator 前由可信策略拒绝，或由运行时资源配置直接限制；对应结果可由单元、集成或事件重算验收。
- **Prompt + Eval**：Prompt 规定理想流程，核心场景评估检查实现轨迹；它不自动成为 runtime 对所有调用者的通用前置拒绝条件。
- **Prompt，当前未见单独 Eval 强制**：Prompt 有要求，但当前 evaluator 未对该读步骤建立独立强制检查。
- **仅事后验收**：evaluator 可以在 run 结束后判定失败，但这不代表 runtime 在动作发生前已阻止该行为。

尤其不得混淆：SOP 成功前置属于 Prompt + 核心场景 Eval；runtime 只在 `search_sop` 实际返回 `SOP_NOT_FOUND` 后软停止。两次动作 `TIMEOUT` 先于 force 是完整恢复场景的 Prompt/Eval 预期，不是 force 的通用 runtime 前置限制。审批等待 timeout/cancel 属于 hard stop，统一以 `APPROVAL_CANCELLED` 结束并只由 host 工单兜底；真正用户 reject 保留为 `APPROVAL_REJECTED` 软停止。`FAIL` 是事后结论，不等于运行前 hard block。

## Run manifest v2 与 provenance

新 run 使用 manifest v2；旧 v1 run 保持原样兼容读取，不补写、不迁移、不改写历史 artifact。实现入口为 [run-provenance.ts](../src/trace/run-provenance.ts)。v2 额外包含：

```text
provenance:
  schema_version: 1
  basis: compiled-javascript
  code:
    sha256: <文件列表聚合 hash>
    files:
      - path: <稳定相对路径>
        sha256: <逐字节 SHA-256>
  evaluator:
    version: business-evaluator-v2
    sha256: <文件列表聚合 hash>
    files:
      - path: <稳定相对路径>
        sha256: <逐字节 SHA-256>
```

约束如下：

- `code.files` 覆盖当前运行模块所在编译 `src` 目录的全部 `.js` 磁盘产物，是保守范围，不按调用图缩小；缺失编译产物时必须使 provenance 生成失败，不做假 hash。
- `evaluator.files` 的完整闭包定义为从 `code.files` 中按 `eval/`、`contracts/`、`trace/` 过滤得到的完整子集，不是调用图精确分析；评估器版本固定为 `business-evaluator-v2`。
- 文件路径使用稳定相对路径；每个文件按字节计算 SHA-256，文件列表再按稳定顺序形成聚合 SHA-256。
- 路径根从 `import.meta.url` 推导，不根据证据输出位置猜 `projectRoot`，也不依赖 Git 或数据库。
- provenance 用于重现与兼容性诊断，不是签名认证、发布证明或供应链安全证明。
- provenance 不宣称在运行中重编译时具有快照原子性；它记录文件读取/哈希时观察到的保守磁盘清单，不能作为同一时刻的不可变发布证明。

## recompute 兼容性诊断

recompute 新增 `evaluator_compatibility` 诊断，不改变原有 metrics 比较规则、差异列表语义或进程退出码，也不自动调用或运行旧评估器：

| 诊断 | 含义 |
|---|---|
| `MATCH` | v2 provenance 的 evaluator version/hash 与当前评估器指纹一致 |
| `DIFFERENT` | 可读取 evaluator provenance，但与当前评估器指纹不一致 |
| `LEGACY_UNKNOWN` | v1 run 没有 evaluator provenance，无法证明兼容；不据此重写旧 metrics |

历史 4 个 evaluator v1 `sop_missing` 差异继续作为已解释差异保留。`LEGACY_UNKNOWN` 只表示“无法从旧 manifest 证明兼容”，不等于旧 run 无效，也不自动产生新的 metric 差异。

## 模块拆分结果

目标文件已落地并完成集成验证。链接均指向最终源码：

| 区域 | 兼容门面 | 拆分单元 | 边界 |
|---|---|---|---|
| app | [business.ts](../src/app/business.ts) | [business-cli.ts](../src/app/business-cli.ts)、[business-run.ts](../src/app/business-run.ts)、[business-batch.ts](../src/app/business-batch.ts)、[business-recompute.ts](../src/app/business-recompute.ts)、[business-io.ts](../src/app/business-io.ts) | 分别承载 CLI、单 run、批次、重算和 IO，门面保留兼容导入 |
| harness | [business-runtime.ts](../src/harness/business-runtime.ts) | [runtime-types.ts](../src/harness/runtime-types.ts)、[runtime-events.ts](../src/harness/runtime-events.ts)、[runtime-approval.ts](../src/harness/runtime-approval.ts)、[runtime-support.ts](../src/harness/runtime-support.ts) | 组合原生 Loop、事件、审批和运行支持，不越过 tools/services 边界 |
| tools | [tool-boundary.ts](../src/tools/tool-boundary.ts) | [tool-validation.ts](../src/tools/tool-validation.ts) | 提纯参数、输出和边界校验，不改变七工具协议 |
| eval | [business-acceptance.ts](../src/eval/business-acceptance.ts) | [business/types.ts](../src/eval/business/types.ts)、[evidence-parsers.ts](../src/eval/business/evidence-parsers.ts)、[scenario-expectations.ts](../src/eval/business/scenario-expectations.ts) | 评估器保留自己的 canonical、解析、审批验证与场景算法，不与执行层共用判定 |
| contracts | [policy.ts](../src/contracts/policy.ts)、[tool-protocol.ts](../src/contracts/tool-protocol.ts) | [canonical-json.ts](../src/contracts/canonical-json.ts)、[provenance.ts](../src/contracts/provenance.ts) | 集中预算/软停/动作 limits/版本默认 model、七工具/schema、执行与证据共用的 canonical JSON，以及 v2 provenance 类型 |

主要文件最终行数：`app/business.ts` `905 -> 5` 门面；`business-cli/run/batch/recompute/io = 197/338/225/127/101`；`harness/business-runtime.ts` `990 -> 522`；`tools/tool-boundary.ts` `885 -> 641`；`eval/business-acceptance.ts` `1609 -> 785`。评估器继续保留独立算法。

七工具、恢复策略、审批和预算没有变化。SOP 矩阵只解释 Prompt、执行前硬约束和事后验收的边界，不新增 runtime 强制读取顺序或通用 SOP 前置。拆分保留原有业务入口和七工具 API；manifest v2 与版本归因查询是本轮明确新增的契约。拆分不引入语义工单去重或由执行层复用的 evaluator 判定捷径。

## 集成验证结果

证据目录：[engineering-refactor-20260926T132019Z](../evidence/verification/engineering-refactor-20260926T132019Z/)。总状态：`PASS_WITH_EXPECTED_LEGACY_DIFFERENCES`。

| 检查 | 准确结果 | 证据 |
|---|---|---|
| `typecheck` | exit `0` | [typecheck.log](../evidence/verification/engineering-refactor-20260926T132019Z/typecheck.log) / [commands.json](../evidence/verification/engineering-refactor-20260926T132019Z/commands.json) |
| `lint` | exit `0` | [lint.log](../evidence/verification/engineering-refactor-20260926T132019Z/lint.log) |
| `build` | PASS；由 `test:unit`、`test:integration`、offline `eval` 中的 `tsc` 实际执行 | [test-unit.log](../evidence/verification/engineering-refactor-20260926T132019Z/test-unit.log) / [test-integration.log](../evidence/verification/engineering-refactor-20260926T132019Z/test-integration.log) / [eval-offline.log](../evidence/verification/engineering-refactor-20260926T132019Z/eval-offline.log) |
| unit | `182/182 pass / 0 fail / 0 skip` | [test-unit.log](../evidence/verification/engineering-refactor-20260926T132019Z/test-unit.log) |
| integration | `10/10 PASS` | [test-integration.log](../evidence/verification/engineering-refactor-20260926T132019Z/test-integration.log) |
| offline eval | `30/30 scenario PASS`、`task_success=15/30`、`unsafe=0` | [eval-offline.log](../evidence/verification/engineering-refactor-20260926T132019Z/eval-offline.log) |
| manifest v2 / evaluator | 新 40 runs 全部 `schema_version=2`；`evaluator_compatibility=MATCH 40`、`DIFFERENT=0` | [verification-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) |
| 历史完整性 | 108 个历史 run 重构前后 metrics `108/108` 一致；736 个 evidence/results 文件 SHA-256 `736/736` 未变 | [verification-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) |
| 全历史 recompute | 148 runs：当前 `144 MATCH + 4` 个原 evaluator v1 差异；`LEGACY_UNKNOWN=108`、`MATCH=40`、`DIFFERENT=0`；退出码仍为 `1` | [recompute-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/recompute-summary.json) / [recompute-all.json](../evidence/verification/engineering-refactor-20260926T132019Z/recompute-all.json) |
| live / manual / clean-room | 本轮新增 `0`；不拿旧 live/manual/clean-room 替代本轮结果 | [verification-summary.json](../evidence/verification/engineering-refactor-20260926T132019Z/verification-summary.json) |
| 文档链接测试 | `4/4 PASS` | 修改后执行 `node --test build/tests/architecture/docs.test.js` |

全历史 recompute 的退出码 `1` 是 4 个已保留 evaluator v1 差异导致的预期状态，不是新回归；不能写成“全历史零差异”。`LEGACY_UNKNOWN` 也不等于 metrics 不一致。
