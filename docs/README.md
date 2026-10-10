# RobotOps Harness Lab 文档导航

## 当前状态（2026-10-10）

- 代码路径已完成：七工具边界、有限重试、`force_reboot` 外部一次性审批、Trace 与独立重算。
- 旧版本评测证据已随评估器更新清理；`evidence/`、`results/` 只在本地生成，不入库。
- 可离线复现：`npm run test:unit`、`npm run test:integration`、`npm run eval -- --offline`、`npm run recompute`。
- 待用户重录：live 评测（`npm run eval`）与真实 manual Demo（`npm run demo`），均需本人的 `DEEPSEEK_API_KEY`。

## 文档

| 文档 | 内容 |
|---|---|
| [架构约束](./architecture.md) | 定位与边界、模块分层、业务契约、安全预算与审批、恢复时序、Trace 与评测、阶段状态（唯一权威入口） |
| [Demo 与真实人工审批](./demo.md) | manual Demo 的操作流程、审批命令与验收口径 |
| [Dashboard](./dashboard.md) | 本地只读历史 Run 查看器 |

## 文档规则

- 安全边界、停止语义和指标定义只在 [架构约束](./architecture.md) 维护，其它文档只链接不复制。
- 文档中的数字必须能由当前代码在本地重新生成；不引用已清理的旧版本证据。
