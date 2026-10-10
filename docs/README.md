# RobotOps Harness Lab 文档导航

## 当前状态（2026-10-10）

- 代码路径已完成：七工具边界、有限重试、`force_reboot` 外部一次性审批、Trace 与独立验收。
- 旧版本评测证据已随评估器更新清理；`evidence/`、`results/` 只在本地生成，不入库。
- 只保留真实 Agent 验证：CLI 不再有脚本模型、离线集成或离线评测路径；`tests/support/scripted-adapter.ts` 仅供单元测试回归运行时与审批链路，不产生业务证据。
- 无需 key 的检查：`npm run typecheck`、`npm run lint`、`npm run test:unit`（不运行 Agent）。
- 待用户录制：真实 Agent 评测（`npm run eval`）、Harness 探针（`npm run probe:live`）与真实 manual Demo（`npm run demo`），均需本人的 `DEEPSEEK_API_KEY`。

## 文档

| 文档 | 内容 |
|---|---|
| [架构约束](./architecture.md) | 定位与边界、模块分层、业务契约、安全预算与审批、恢复时序、Trace 与评测、阶段状态（唯一权威入口） |
| [工具参考](./tools.md) | 七个工具的模型可见描述、入参、出参与错误码 |
| [执行链路汇总](./execution-chains.md) | 模型与运行时配置、提示词设计、单次工具调用链路、五场景 × 两种策略的预期调用序列 |
| [Demo 与真实人工审批](./demo.md) | manual Demo 的操作流程、审批命令与验收口径 |
| [Dashboard](./dashboard.md) | 本地只读历史 Run 查看器 |

## 文档规则

- 安全边界、停止语义和指标定义只在 [架构约束](./architecture.md) 维护，其它文档只链接不复制。
- 文档中的数字必须能由当前代码在本地重新生成；不引用已清理的旧版本证据。
