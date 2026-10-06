# 阶段 6：Demo、README 与求职展示
> 状态：`DONE`。README、`npm run demo`、manual TTY 契约和 [Demo 说明](./demo.md) 已实现；1 次独立真实 manual run 已成功并复核，两次历史 timeout 保留为 NOT APPROVED 负例。视频/截图仍是可选素材，缺失不阻塞既定 MVP gate。

## 目标

用 CLI 或已有原生 UI 完成可理解、可复核的真实演示，并把实际实现、测量结果、失败样本和边界整理为求职展示材料。

1. README 首屏在 10 秒内说明项目是什么、核心 Demo 是什么、已有真实结论是什么。
2. 演示必须走真实模型、真实工具、策略拦截和真实人工批准，不硬编码成功路径。
3. 展示 `navigation_restart_fail_then_reboot` 的两次失败、拦截、人工批准、`force_reboot`、状态读取、任务恢复和 Trace 指标。
4. 清晰区分 Harness 原生能力、项目自实现、Mock 和尚未验证内容。
5. 只写实际实现和实际测量，公开失败样本，并说明结论的适用性；不宣称 Harness 优于其他框架。

### 展示范围

未来 Demo 使用 CLI 或已有原生 UI，不新建 Dashboard。完整 Demo 的目标是让 Reviewer 在约 3 分钟内理解问题、失败、恢复、审批、最终状态、成本与证据来源。README 明确注明本项目按一周约 40 个有效工时进行 MVP 估算，该数字是计划估计而不是测量值。

> **决策反转说明（2026-09-28，不改写历史）：** 本阶段当时决定“不新建 Dashboard”，该决定后来被反转——项目在 2026-09-28 补充了只读的本地历史 Run 查看器 Dashboard（`npm run dashboard`，见 [Dashboard 说明](./dashboard.md)）。反转的原因是 Dashboard 只读 `results/` 历史证据，不启动模型、不执行动作、不参与审批，因此不违反本阶段“真实模型 + 真实人工批准”的 Demo 契约；Demo 主路径仍以 CLI 和真实人工审批为准，Dashboard 只是查看历史 Run 的辅助入口，且它没有归档验证产物。上面这段原始决策按历史保留。

## 前置条件

- 完整阅读 [架构约束](architecture.md) 与 [根 AGENTS.md](../AGENTS.md)。
- 阶段 5 已完成，五场景批次、独立真实人工审批演示和可重算结果均存在。
- Harness 原生 Loop、七工具、策略层、Services、Simulator 和 Trace 已通过阶段 3 至阶段 5 的验收。
- 有真实外部人员可执行一次绑定具体调用与参数的人工批准；脚本 approval 不能替代。
- README 所需命令、配置、截图或视频素材均有真实来源；没有素材时明确缺失，不伪造。
- 真实核心 manual Demo 已完成；文档、脚本 approval 或离线结果仍不能作为未来真人演示证据。

## 修改范围

未来阶段 6 只计划修改或新增：

- 项目根 `README.md`，以及必要的真实 Demo 使用说明和证据索引。
- 与已有 CLI 或原生 UI 对应的演示入口说明；不创建新的 UI 层（此条为阶段 6 当时范围，已被 2026-09-28 的只读 Dashboard 决策反转，见上方说明）。
- 经过验证的安装、配置、启动、运行、测试和结果查看说明。
- 真实人工审批演示记录、结果表引用、失败样本和边界说明。
- 可选的真实 Demo 录屏或现场演示材料。

不修改 Agent Loop、七工具、Simulator 业务语义、安全策略或评测算法。Decision Memo 可以是 README 的独立段落，当前无需新增 `docs/decision_memo.md`。未来任何未来产物只在真实创建并验证后引用，不给不存在的文件制造相对链接。

## 实现约束

### README 首屏与结构

README 开头必须先给一句话项目定位、核心 Demo 和真实结论，再进入理论。推荐结构必须覆盖：

| 主题 | 必须回答 |
| --- | --- |
| Why | 为什么机器人运营任务需要恢复、权限与审计 |
| Architecture | Harness 原生 Loop、项目策略、Services、Simulator 的边界 |
| Demo | 如何运行核心场景，看到哪些真实状态 |
| Recovery | 失败、显式重试、恢复、写后读取和最终状态 |
| Approval | 保护动作如何默认拒绝，人工批准如何绑定且一次性 |
| Eval | 五场景、两配置、30 次真实模型实验与独立人工演示 |
| Results | 只展示 `MEASURED` 结果、样本量和失败样本 |
| Capability Boundary | Harness 原生、项目自实现、Mock、未验证四类明确分开 |
| Limitations | 小样本、Simulator、无实机、无生产安全承诺、适用边界 |
| Decision Memo | Continue、Adjust、Do Not Use，以及适用条件的真实解释 |
| How to Run | 新人可执行的安装、配置、启动与最小演示入口 |
| Tests | 实际命令与 PASS/FAIL/SKIPPED/NOT_TESTED 状态 |

### 真实 Demo 契约

固定使用 `navigation_restart_fail_then_reboot`，必须展示：

```text
真实模型任务
→ 读取机器人状态与 SOP
→ restart_navigation 第一次失败
→ 显式重试并第二次失败
→ force_reboot 进入项目 default-deny：blocked / 等待授权，尚未执行
→ 真实人工批准
→ force_reboot 实际执行
→ 重新读取 robot 状态
→ resume_task
→ 重新读取 task 状态
→ Trace 与指标
```

核心完成状态只要求机器人 `MOVING` 且 `TASK-502=RUNNING`，不是配送任务 `COMPLETED`。保护动作始终默认拒绝，不允许任何配置关闭安全层。Demo 不得用脚本 approval、预置输出、手工改状态或硬编码最终成功来替代真实路径。

### 结果真实性

- 只把真实运行得到的 `MEASURED` 数字写入结论；未获取的 token/cost 写 `NOT_MEASURED`，不能写 `0`。
- 强调 30 个 run 是小样本 MVP 验证，不代表生产统计显著性，也不能证明其他框架更差。
- 公开失败样本；不能只展示成功案例或静默删除基础设施失败。
- 将 README 陈述分类为 `MEASURED / IMPLEMENTED / DOCUMENTED / INFERRED / PLANNED`，每项能追溯到代码、命令输出或结果文件。
- 简历总结只能写实际实现并实际测量的内容，不把规划、Mock、推断或离线路径包装成生产能力。
- 机器人 API 是 Simulator；没有真实机器人、没有 3D 物理仿真、没有生产环境、没有可靠沙箱承诺。

### 演示素材

未来计划录制 30 至 60 秒 Demo，或提供能在大约 3 分钟内理解主流程的真实现场演示。若无法稳定录制，保留 CLI 运行和 Trace 证据，不得伪造视频、拼接不存在的输出或把脚本运行描述为真实人工审批。演示中的 manual approval 必须能识别来源、审批对象、参数、一次性语义和事件顺序。

## 验证命令

### 展示验收接口与当前状态

以下保留 Demo 验收接口，并区分 scripted 自动证据与已完成的真实 manual：

| 命令 / 入口 | 当前状态 | 展示验收边界 |
| --- | --- | --- |
| `npm run typecheck` / `lint` / `test:unit` / `test:integration` | PASS | 见 [实现报告](./implementation-report.md) |
| `npm run test:e2e` | PASS（scripted） | 最新真实模型 `restart_success`，不等于核心 manual |
| `npm run eval` | PASS（scripted，30/30） | 自动消融，不等于人工演示 |
| 用户真实 manual Demo | PASS | [manual proof](../evidence/verification/delivery-20260926T202502/manual-proof.json)；approved、allowed-once、审批先于动作、`MOVING/RUNNING` |
| 历史 manual timeout #1/#2 | FAIL（120 秒超时） | 两条未获批 run 保留；不能归为批准或拒绝 |
| auto rehearsal | 可复核，但 scripted | 使用 [demo.md](./demo.md) 中的 trace；只补充，不能当 manual |

真实 Demo 入口已经固定在 `package.json` 和 `src/app/business.ts`。当前有获批的 manual run、业务/原生 Trace 和独立 proof；没有视频或截图不影响既定 MVP gate，仍不得用 rehearsal、timeout、文档或预置输出冒充未来的人工审批。
## 完成标准

以下阶段 6 完成条件现已满足：

- README 首屏包含一句话定位、核心 Demo 和真实结论，10 秒内可理解项目。
- README 覆盖推荐结构、Harness 原生与项目自实现边界、Mock、未验证项、限制和 Decision Memo。
- 真实 Demo 完整展示两次失败、拦截、真实人工批准、`force_reboot`、写后读取、resume 和 task 验证。
- 最终业务状态是机器人 `MOVING` 且 `TASK-502=RUNNING`，不是配送 `COMPLETED`。
- 展示结果来自可重算证据，30 次自动实验与至少 1 次真实人工审批演示分开报告。
- README 不含未经证据支持的结论，不夸大样本，不隐藏失败，不把计划或 Mock 写成已实现。
- 新人可按 README 安装、配置并启动最小路径；关键验证项有状态，clean-room 与真实 manual 证据已闭环。
- 可选的视频或截图当前不存在且已明确说明；没有用伪造媒体补位。

## 失败时如何处理

- 没有真实人工批准：Demo 标记 FAIL/BLOCKED，不以脚本 approval 冒充，也不宣称完整审批链路已展示。
- 模型凭据或依赖不可用：记录错误并阻塞真实 Demo；离线测试可以报告，但不能称为真实人工审批演示。
- Demo 只能通过硬编码、改状态、预置输出或隐藏失败得到成功：停止展示，回退到真实证据并修复后再验收。
- README 结论找不到结果文件或命令输出：删除、降级为 `PLANNED` 或标记未验证，不能保留夸大陈述。
- 发现 secret、认证头、令牌或内部凭据进入文档或素材：停止发布，交由主 Agent 按安全流程撤销、轮换和清理；处理过程不得读取凭据。
- 结果不可重算、失败样本丢失或真实事件与展示不一致：展示不得验收，使用保留的原始证据重新导出。
- 清理文件、重命名或改动范围外内容需要新设计决策：停止并升级主 Agent，不自行扩大范围。
- 阶段 6 完成报告后停止；不提前新增功能或进入阶段 7 的实际审计。





