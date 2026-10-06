# 历史 Run 查看器

Dashboard 是一个只读的本地历史运行查看器，用于按场景和策略查看已经落盘到 `results/` 的 Run 证据。它不会启动模型、执行机器人动作、调用工具或审批接口，也不会修改任何证据文件。

## 启动

```powershell
npm run dashboard
```

默认地址为：

```text
http://127.0.0.1:4317
```

如需使用其他端口：

```powershell
npm run dashboard -- --port 4318
```

服务只绑定 IPv4 loopback，仅接受本机访问。端口必须是 `1` 到 `65535` 之间的整数；端口被占用或参数无效时，命令会友好退出。Dashboard 不读取 `.env`，只在当前进程中存在 `DEEPSEEK_API_KEY` 时将其用于响应脱敏。

## 使用方式

- 首页先按 Agent 驱动方式（底层字段 `mode`）、审批来源和批次筛选历史 Run；选项来自当前已读取的证据，`all` 表示不过滤。
- 历史 Run 按 `mode + scenario_id + config + approval_source` 分组展示，不把真实模型（live）/预设脚本（offline）、人工/脚本或其他配置混算在同一组。
- 每组按稳定场景顺序排列，组内 Run 按 id 倒序。新增场景、配置或审批来源会形成独立组，不会并入已知组。
- 页面不会自动刷新。点击“刷新历史”（保留当前选择）或刷新浏览器以查看新完成的 Run。
- 审批仍然在终端中完成。Dashboard 只展示历史证据，不能批准、拒绝或发起任何运行。
- 单 Run 详情不再是首页入口；完整证据结果应通过分组和组内 Run 列表逐层查看。
- 无效、缺失或过大的证据文件会显示通用问题提示，其他仍然可读的内容继续展示。

## 分组指标

每个场景策略组同时展示任务结果、场景验收、安全动作、耗时与证据问题：

- `task.rate = task.success / task.measured`，其中 `task_success` 只有在严格为 boolean 时才计入 `task.measured`。
- `scenario.rate = scenario.success / scenario.measured`，其中 `scenario_pass` 只有在严格为 boolean 时才计入 `scenario.measured`；任务恢复与场景验收分开，不能互相替代。
- `measured` 为 `0` 时，对应比率为 `null`，不会显示为 `0%` 或 `100%`。
- `unsafe.sum` 只累加非负安全整数；`unsafe.measured` 统计有效样本数。数值 `0` 是有效测量，缺失值不是。
- `active.meanMs` 和 `approvalWait.meanMs` 只对 finite 且不小于 `0` 的数字求均值；`NOT_MEASURED`、`null`、缺失字段、字符串和负数均不进入各自分母。两种耗时始终分开计算。
- `statuses` 只把精确的 `PASS`、`FAIL`、`BLOCKED` 归类，其他或缺失状态归入 `unknown`。
- `issueRuns` 和 `integrityIssueRuns` 只提示存在证据问题的 Run，不排除这些 Run，也不重算 evaluator 或修改原指标。

## 逻辑归档

Dashboard 支持通过后端归档配置将旧 Run 排除在列表、分组和统计之外，但不会删除、移动或改写任何 Run 证据目录。配置文件为：

```text
results/.dashboard-archive.json
```

文件格式如下：

```json
{
  "schema_version": 1,
  "archived_at": "2026-09-28T00:00:00.000Z",
  "run_ids": ["20260926T101953Z-offline-248f8146-a7e2-4842-a624-48aef592c0ee"]
}
```

- 列表只排除 `run_ids` 中的合法 Run ID；旧 Run 的原始文件仍保留在 `results/`。
- 直接访问 `/api/runs/<run_id>` 详情时仍可只读查看已归档 Run，方便保留现有文档引用。
- 配置只由后端读取，不提供修改、创建或删除归档的路由。
- 配置缺失时按无归档处理。配置是非普通文件、符号链接、指向 `results` 之外、超过 8 MiB 或内容不符合 schema 时，列表 API 返回 `500`，不会回退显示旧历史。

恢复逻辑归档前应先备份配置和快照。恢复时可以从 `run_ids` 中移除对应 ID，使这些 Run 重新进入列表；也可以移动归档配置文件，使全部旧 Run 再次可见。不要在没有明确确认时擅自执行恢复操作。

## 只读与安全边界

- 仅支持 `GET` 和 `HEAD`，其他方法返回 `405`。
- 仅提供首页、`app.js`、`grouping.js` 和 `style.css` 四个固定静态文件，不提供项目目录下载或 `results/` 文件下载。
- API 响应会再次经过脱敏，并设置 CSP、`X-Content-Type-Options: nosniff` 和 `Cache-Control: no-store`。
- `Host` 和 `Origin` 仅允许本机 loopback 地址，以降低 DNS rebinding 风险。

## 展示提示

Dashboard 展示的是跨批次、跨版本汇总的离线样例、模拟器证据或历史运行结果，不代表实机运行，也不能解释为因果对照或实机可靠性。证据文件可能不完整，缺失字段或坏 JSONL 行会以问题列表提示；请结合终端输出、Trace 和完整证据目录判断运行状态。