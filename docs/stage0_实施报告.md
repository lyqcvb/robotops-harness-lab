# 阶段 0 实施报告

> 状态：2026-09-26 最终验收记录。主 Agent 已真实执行并复核指定 live run：`status=PASS`、`stage0Complete=true`，5 个 Gate 全部 `PASS`。
> 范围：仅 Stage 0 原生运行时与无业务副作用探针完成；Stage 1..7、业务 Simulator / Services / Eval 仍为 `PLANNED`，不代表全项目完成。
>
> **2026-10-06 当前状态（更正）：** 上面这行只描述 Stage 0 当时的状态；Stage 0–7 现已全部 `DONE`，`test:e2e` 与 `eval` 均已实现并有真实运行证据，不再是 `PLANNED` / exit 2 占位。当前口径以 [文档导航的「当前状态」](./README.md) 与 [架构约束](./architecture.md) 为准，下文表格保留 Stage 0 当时口径。
> 迁移说明：本报告主体保留迁移前的 run、统计和结论，不因新复验改写或替换。迁移范围、当前 live/offline 证据与验证结果见 [Stage 0 架构迁移与复验记录](./architecture-migration.md)。
>
> 链接口径：本文的本地源码链接指向当前去编号实现；正文 run、统计和验收结论属于当时版本，本轮结构迁移未新增 live/manual 复跑。

## 摘要与状态

当前选定最终验收 run 为 `20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522`，以 [summary.json](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/summary.json)、[native-events.jsonl](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/native-events.jsonl)、[probe-events.jsonl](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/probe-events.jsonl) 为依据。主 Agent 最终执行 `npm run test:integration`，真实 exit 0；该入口是 **Stage 0 live smoke**，不是机器人业务 E2E。

| 验证层 | 最终记录 | 结论边界 |
|---|---|---|
| 确定性工具链 | 主 Agent 最终重跑 typecheck、lint、test:unit 全部通过；20 tests / 20 pass / 0 fail / 0 skip | 构建由单元和集成入口执行；不等于业务测试完成 |
| 原生运行时 | 原生 Loop、工具、审批与 Session/JSONL 已实际验证 | 不是仅装包或 idle agent 的静态推断 |
| 真实模型 | `deepseek-official` / `deepseek-flash`；LIVE case 独立 2 次请求、1 次只读工具请求与 stub 执行、0 次审批 | 仅证明只读 stub 工具调用与结果回读；没有机器人业务动作 |
| 后续阶段 | `PLANNED` | 真人审批、业务恢复、Eval 与完整交付仍待 Stage 1..7 |

早期只读 `GET /models` 的 HTTP `200` 记录继续保留为凭据与代理连通性证据；它本身不证明生成或 Tool Call。本次真实 Tool Call 的结论来自上面的最终 run，而非只读鉴权结果。

## 设计决策及范围

- 固定为 TypeScript 单栈、单进程、串行执行，使用官方运行时模块直接组合 Harness 原生 Loop；不安装或调用通用 `dsh` CLI，不使用 default 大预设，也不自写替代 Loop。
- 原生能力包括 Loop、工具注册/调度、审批事件、Session 与 JSONL 持久化；项目适配包括七工具 stub、宿主身份、default-deny 与一次性 guard、独立验收判定和证据脱敏。
- 七工具 stub 只有计数与确认输出。`actionExecutions` / `PROBE_STATE_UPDATE` 表示 stub handler 计数，不是机器人、任务或工单状态；没有机器人业务副作用。
- 审批安全测试全部使用 scripted 答复器，不是真人人审演示。Stage 4/6 仍必须完成真实人工审批。
- Stage 0 范围不进入 Simulator、Services、业务主流程、Eval 或 Dashboard 实现。共同业务契约与预算保持 [架构约束](./architecture.md) 原定义。

## 精确环境版本与来源

### 运行时与工具链

| 项目 | 实际版本 | 来源 |
|---|---|---|
| Node.js | `24.14.0` | 本机 `node --version` |
| npm | `11.9.0` | 本机 `npm --version` |
| TypeScript | `5.9.3` | [package.json](../package.json) 与 [package-lock.json](../package-lock.json) |
| ESLint | `9.39.4` | 同上 |
| `@eslint/js` | `9.39.4` | 同上 |
| `typescript-eslint` | `8.70.1` | 同上 |
| `@types/node` | `24.3.0` | 同上 |
| npm registry | `https://registry.npmjs.org` | 锁文件解析地址，未切换镜像 |

### Harness 包

| 包 | 锁定版本 |
|---|---:|
| `@deepseek-ai/cordis` | `4.0.2` |
| `@deepseek-ai/dsh-agent-loop` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-agent` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-session` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-tools` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-llm` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-llm-deepseek` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-scope` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-system-prompt` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-user-approval` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-session-projection` | `0.1.5-rc.3` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | `0.1.5-rc.3` |

npm latest 的 2026-09-26 查询记录为 `0.1.5-rc.3`，next 标签记录为 `0.1.7-rc.2`。这只是查询记录；不能据此声称仓库 `master` 或安装版本就是 `next`。安装事实以 `package-lock.json` 为准。

锁文件为 lockfile v3。安装记录为 153 个包；lockfile 的 `packages` 映射包含 177 项，其中有平台/可选解析条目，因此不把两个计数机械等同。未执行或宣称安全审计通过。

### 本次环境诊断

本段只记录当前机器的一次诊断，不是通用默认，也不是新人必须配置的项目端口：

- npm 直连曾出现 `ETIMEDOUT`。根因是 Windows 系统代理 `127.0.0.1:7890`，npm 默认不继承该代理。
- 恢复官方 registry 访问的方式仅为每条 npm 命令传入 `--proxy` 与 `--https-proxy`；没有换 registry 镜像，也没有修改全局 npm 设置。
- `127.0.0.1:7890` 只属于本次机器诊断。新人必须使用自身代理环境值，不要求该端口；仓库脚本通过 `--use-env-proxy` 读取环境。
- 项目 `.env` 中 API key 的 presence 为 `true`；报告不保存 key 值。主 Agent 使用该凭据对官方 `GET https://api.deepseek.com/models` 做只读鉴权，得到 HTTP `200`，日志只保留 presence、状态和模型 ID。
- 模型 ID 为 `deepseek-flash`、`deepseek-v4-pro`；后续默认采用 `deepseek-flash`。该检查不证明真实生成、Tool Call、审批或持久化已经通过。

### 官方接口依据

接口说明使用已安装本地版本的 package README、`.d.ts` 和主 Agent 的源码/内存检查，不把官方仓库主线签名套用到本地版本：

- Cordis 4：`await ctx.plugin(...)` 装载插件，`ctx.fiber.dispose()` 回收。该版本不存在 `ctx.start/stop`。
- Agent：`ctx.agents.create(...)` 返回 `agent/dispose`；使用 `agent.followup(...)` 与 `agent.whenIdle()`。
- Tools：本地 rc.3 的 `dsh-tools` 暴露 `defineTool`、`tools.guard()` 与 `'tools/pre-execute'` waterfall。
- Approval：本地 rc.3 的 `dsh-user-approval` 暴露 `request(req)`；`allowed-once` 是唯一授权结果。
- Session：本地 rc.3 的 `dsh-session` 暴露 append-only `session/event`；JSONL 持久化由对应包提供。

官方一手来源：[npm latest 查询记录](https://registry.npmjs.org/@deepseek-ai%2fdsh/latest)、[仓库 README](https://github.com/deepseek-ai/deepseek-harness)、[tools.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md)、[SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。接口结论以本地 `0.1.5-rc.3` d.ts/README 为准，不把主线 master 声明当作安装版本。

## 能力矩阵

| 能力域 | 归属与证据类别 | 实际验证 | 结论与限制 |
|---|---|---|---|
| 精确依赖与锁版本 | 官方包 / 静态 | `static-versions=PASS` | 安装元数据与 lockfile 一致；不宣称安全审计通过 |
| Harness Loop | 原生 / 离线 + 真实模型 | 9 个 scripted cases 与 LIVE case 均通过 | 官方 Loop 驱动；只验证 Stage 0 探针流程 |
| Tools / 七工具白名单 | 原生注册/调度 + 项目 Stub | `offline-whitelist=PASS`；LIVE 调用只读 `get_robot_status` | 七工具 schema 可核对；不代表七个业务工具或七次 live 调用 |
| 审批 / 执行边界 | 原生 Approval + 项目适配 | `offline-safety=PASS` | default-deny、调用/参数绑定、一次性、取消/过期和旁路 guard 已验证；审批来源全部 scripted |
| Session / JSONL | 原生 / 运行验证 | `offline-persistence=PASS`；LIVE 持久化亦通过 | 官方 read 路径逐事件与 snapshot 核对，不是只看文件存在 |
| 独立判定与证据脱敏 | 项目适配 / 确定性验证 | [probe-acceptance.ts](../src/eval/probe-acceptance.ts)、[probe-evidence.ts](../src/trace/probe-evidence.ts) 与最终 20 个单测 | 将原生事件与 stub 计数交叉核对，保存脱敏证据；不是生产安全隔离证明 |
| DeepSeek 凭据/代理 | 真实只读验证 | 官方 `GET /models` HTTP `200` | 仅为环境诊断；与生成证据分开 |
| 真实模型 Tool Call | 原生 + 官方 Provider / 真实验证 | `live-gate=PASS`，`deepseek-official` / `deepseek-flash` | 2 次真实 Provider 请求、1 次只读 stub 调用及结果回读 |
| Simulator / Services / 业务 E2E / Eval | 项目后续阶段 | `PLANNED` | 尚未实现；`test:e2e` 和 `eval` 当前明确 exit 2 |

原生生命周期的早期内存诊断挂载过 `llm,sessions,agents,tools,systemPrompt,sessionProjections,approval,agentLoop` 8 个服务并创建 idle agent，当时 `schemas=[]`；该历史记录只证明生命周期装配。现在的工具/审批/持久化结论来自最终探针，不把初始空 schema 或静态依赖包当作运行能力。

## 最终运行统计与事件核对

| 统计范围 | cases | 模型请求 | 工具请求 | 实际 stub 执行 | 审批 asked / native allowed-once | native / probe 行数 |
|---|---:|---|---:|---:|---:|---:|
| 最终 live 批次（含 offline probes） | 10 | 21 = 19 scripted + 2 live | 11 | 3 | 5 / 2 | 175 / 33 |
| 上述批次的 LIVE case 子集 | 1 | 2 次真实 Provider 请求 | 1 | 1（只读） | 0 / 0 | 16 / 4 |
| 独立 offline run | 9 | 19 次 scripted 请求；0 次真实 Provider 请求 | 10 | 2（A 只读 1 + E 保护 stub 1） | 5 / 2 | 159 / 29 |

独立 offline run 为 `20260926T083937Z-offline-50bba941-86c9-499b-94a4-4bd93a210937`。其 9 cases 全部通过，但 summary 中 `stage0Complete=false`、live gate 为 `NOT_RUN`，这是 offline 模式的正确边界，不能单独作为阶段完成证据。LIVE 子集不是额外可累加的批次；**最终批次的 21 次不能写成 21 次真实 API 调用**。预算按独立 probe case/session 执行，LIVE 请求上限更严格为 3 次，本次实际为 2 次；21 是跨 case/session 的批次汇总，不是单业务 run 的预算验收，业务预算仍按架构约束执行。

- LIVE 原生 `tool/call` 为 session `seq=9`，`tool/result` 为 `seq=10`（批次序号分别 169、170）；`callId=call_00_qsy23Yl0LhdHIJJfku4m0288` 匹配，参数为 `robot_id=R-03`。
- 成功 canonical JSON 经工具 render 成文本后从原生 `tool/result` 读回：`status=SUCCESS`、`error_code=null`、`data.probe=true`、`data.robot_id=R-03`、`invocation=1`。这不是机器人状态快照，也不意味着原生 durable 事件保存了独立的 typed canonical value 字段。
- 两个选定 run 的 native/probe `batch_sequence` 均连续为各自的 `1..N`，无序号错误；安全负例的拒绝性 tool result 是预期结果，不是需要隐藏的失败。
- 两次 native `allowed-once` 不等于两次保护 stub 执行：E 授权后执行一次；G-expired 虽得到 native `allowed-once`，仍被项目过期 guard 拦截，执行为 0。LIVE 没有审批，所有审批来源均为 scripted。
- 持久化验证先 flush Session，再走官方 `sessionPersistence` 的 read 路径：`ctx.sessionPersistence.open(sessionId, 'read')` → `handle.read(0)`，逐事件核对序号与 `session.snapshotEvents()`。选定 live 批次 10 个 case、独立 offline 9 个 case 的 `PROBE_PERSISTENCE_READ` 均记录 `matched_snapshot=true`；不是文件存在性检查。

## 运行命令与当前状态


| 命令 | 当前状态 | 说明 |
|---|---|---|
| `npm run typecheck` | `PASS` | 主 Agent 最终重跑通过 |
| `npm run lint` | `PASS` | 主 Agent 最终重跑通过 |
| `npm run build` | `PASS` | 已有构建记录，最终 unit/integration 入口亦先构建 |
| `npm run test:unit` | `PASS` | 最终 20 tests / 20 pass / 0 fail / 0 skip；取代初期 3 个工具链测试的快照 |
| `npm ls --all --depth=99` | 已验证 | 早期依赖树完成记录，非本次迁移新增模型证据 |
| `npm run probe:offline` | `PASS`（offline 范围） | 独立 offline 9 cases；不独立判定 Stage 0 complete |
| `npm run test:integration` | `PASS` / exit 0 | Stage 0 live smoke；最终批次含 offline probes + LIVE，只读 stub，无业务 E2E |
| `npm run test:e2e` | `PLANNED` / exit 2 | 主 Agent 已重验预期占位退出；后续业务阶段接口，不是业务测试 `PASS` |
| `npm run eval` | `PLANNED` / exit 2 | 主 Agent 已重验预期占位退出；Stage 0 不包含此业务能力，不是评测通过 |

### 安装与首次配置

在项目根目录使用锁文件安装；以下为复现说明，该历史记录未重新安装：

```powershell
npm ci --ignore-scripts
```

若网络需要代理，用自身代理 URL 替换占位值，使用下面的安装方式代替上面一条。npm 的代理参数仅作用于当前命令；不改镜像或全局设置，不要求本机诊断端口：

```powershell
$env:HTTPS_PROXY='<your-proxy-url>'
npm ci --ignore-scripts --proxy="$env:HTTPS_PROXY" --https-proxy="$env:HTTPS_PROXY"
```

由用户在本机通过环境变量或已有 `.env` 配置 `DEEPSEEK_API_KEY`；不读取、输出或提交文件内容。默认模型为 `deepseek-flash`，也可用 `DEEPSEEK_MODEL` 覆盖：

```powershell
# 由用户在本机设置 DEEPSEEK_API_KEY；不要输出它的值。
# 如已有 .env，由用户在现有配置中维护。
```

配置就绪后按需执行下列验证；integration 会发出真实模型请求。package 中两个 probe 入口均带 `--use-env-proxy`，使用用户自己的代理环境；直连可用时不必设置代理：

```powershell
npm run typecheck
npm run lint
npm run test:unit
npm run probe:offline
npm run test:integration
```

缺 key 时 integration 必须 `BLOCKED` 且非零退出，不发真实 Provider 请求；保留相应负例，不改用 scripted 模型冒充 live。

## 验收 Gate

以下 5 行与选定最终 [summary](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/summary.json) 的 `gates` 字段逐项对应，替代初稿的待填清单：

| Gate 名称 | 验证类型 | 结果 | 证据范围 |
|---|---|---|---|
| `static-versions` | 静态 | `PASS` | 已安装包元数据与 lockfile 匹配 |
| `offline-whitelist` | 离线原生运行 | `PASS` | 七工具白名单验收 |
| `offline-safety` | 离线原生运行 | `PASS` | scripted 审批与项目执行边界验收 |
| `offline-persistence` | 离线原生运行 | `PASS` | 原生事件配对、JSONL read 与 snapshot 核对 |
| `live-gate` | 真实模型运行 | `PASS` | 真实只读调用、结果可读、原生事件持久化 |

最终 `status=PASS`、`stage0Complete=true`、`blocked=[]`；主 Agent 已完成最终复核。此完成状态仅覆盖 Stage 0，不给未实现的 `test:e2e` / `eval` 或业务能力授予通过结论。

## 证据位置与保留策略

| 选定记录 | summary | 原生事件 | 项目探针事件 |
|---|---|---|---|
| 最终 live 验收：`20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522` | [summary.json](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/summary.json) | [native-events.jsonl](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/native-events.jsonl) | [probe-events.jsonl](../evidence/stage0/20260926T084055Z-live-3314b141-94f5-4572-a10e-5603e187d522/probe-events.jsonl) |
| 独立 offline：`20260926T083937Z-offline-50bba941-86c9-499b-94a4-4bd93a210937` | [summary.json](../evidence/stage0/20260926T083937Z-offline-50bba941-86c9-499b-94a4-4bd93a210937/summary.json) | [native-events.jsonl](../evidence/stage0/20260926T083937Z-offline-50bba941-86c9-499b-94a4-4bd93a210937/native-events.jsonl) | [probe-events.jsonl](../evidence/stage0/20260926T083937Z-offline-50bba941-86c9-499b-94a4-4bd93a210937/probe-events.jsonl) |

- [早期失败 run](../evidence/stage0/20260926T083030Z-offline-2601595a-d903-4993-b11d-7d5a88da041d/summary.json) 的 `FAIL` 原样保留；旧离线 run 也不删除或覆盖。
- 部分 `BLOCKED` 记录是缺凭据的安全负例，例如 [缺 key 样本](../evidence/stage0/20260926T084050Z-live-fdb4b0a8-88cf-46f6-8b53-fba701256896/summary.json)。其中记录没有发出 Provider 请求；不能把这些历史记录改成成功，也不能误作当前选定最终 run 的状态。
- [全部 run 目录](../evidence/stage0/) 保留失败、负例与离线历史；最终验收明确使用上表 live run，不择取局部成功隐藏失败。
- 官方原始 JSONL 在 `.stage0` 隔离根；每 run 独立、不恢复。`evidence` 是脱敏导出，报告只能读取，不能手改或制造。
- 实现入口见 [probe.ts](../scripts/probe.ts)、[probe app](../src/app/probe.ts)、[probe-runtime.ts](../src/harness/probe-runtime.ts)、[package.json](../package.json) 与 [package-lock.json](../package-lock.json)。这些链接指向当前实现，本文的 run/statistics/验收结论仍属于迁移前版本；文档格式检查不属于业务运行证据。

### 凭据检查范围

主 Agent 的 2026-09-26 收尾扫描覆盖 `src`、`scripts`、`tests`、`docs`、`evidence`、`.stage0` 及安全配置等 **377 个文件**，按当前 API key 做精确匹配，结果 **0 命中**。实际 `.env` 特意排除且已列入 `.gitignore`。结论仅为“检查范围内未发现当前 key 外泄”，不是“彻底无任何 Secret”，也不是全面安全审计；本报告不读取 `.env` 或保存 key 值。

## 风险与已知限制

- `0.1.5-rc.3` 的 developer preview/兼容风险继续保留；不宣称生产隔离、安全审计或供应链审计通过。
- 原生能力已在 Stage 0 范围运行验证，但七工具都是计数 stub；不能据此声称机器人恢复、任务恢复、服务协作或完整业务 E2E 已实现。
- scripted 审批不能替代真人；后续 Stage 4/6 必须实际人工确认。LIVE case 0 次审批不能作为真人演示证据。
- 真实生成证据限 `deepseek-official` / `deepseek-flash` 的只读 smoke；不是五场景评测或恢复策略消融，也不是全量功能、安全与性能证明。
- 本机代理诊断不是通用默认；不泄露凭据。offline 与 live 数量严格分开，失败与缺 key 负例完整保留。
- 项目当时仍未初始化 Git（2026-10-06 现状：已是 Git 仓库，分支 `main`）；当时 `AGENTS.md` SHA-256 保持 `072d14f9e200856736401c93f54d498b0fe10bedda2eda3ab59ca12f8f90acd6`，未修改调度规范。

## 进入阶段 1 条件

Stage 0 的依赖、七工具 stub、安全审批、JSONL 读回与真实 Tool Call 前置条件已由上述 5 个 Gate 和主 Agent 最终复核关闭。已具备进入 Stage 1 的前置条件；Stage 1 在明确开始前保持 `PLANNED`。Stage 1..7 的实现与验收继续按既有规划，不能复用 Stage 0 的 `PASS` 代替业务结果。

## 未完成项

- Stage 0 选定最终验收范围内的未解决问题：无。
- Stage 1..7：业务 Simulator / Services、完整恢复、安全与预算集成、Trace/Eval、真人审批、展示与 clean-room 复现均仍为 `PLANNED`。
- `test:e2e` 与 `eval` 仍为明确 exit 2 的占位；后续阶段完成真实实现与验收后才可更改状态。
