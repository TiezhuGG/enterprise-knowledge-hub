# P1-01 验收记录

日期：2026-11-07。范围：工程骨架与开发环境。

| 检查 | 实际结果 |
|---|---|
| Node / npm | 24.22.1 / 11.9.0 |
| 锁文件复现 | `npm ci` 成功；云环境使用 `--cache /tmp/zhiheng-npm-cache` 避免默认 home 缓存不可写 |
| 类型与构建 | `npm run check` 验证全工作区 TypeScript 和构建 |
| 自动化反例 | 无效 API/Redis 端口被拒绝 |
| API 集成测试 | 无存储依赖启动、真实 HTTP 存活响应、未实现业务路由 404、SIGTERM 关闭与同端口重启；2 个测试通过 |
| Compose | `docker compose config --quiet` 通过；PostgreSQL 与 Redis 实际拉取启动后均 healthy |
| 独立 Worker | API 与 Worker 分别运行；`npm run smoke:queue` 随机 nonce 往返通过 |
| Worker 重启 | SIGTERM 停止 Worker，重新启动后再次消费排队 ping 成功；API 保持运行 |
| 浏览器 | 使用 Playwright + 系统 Chromium，真实页面连接 API 成功；模拟 HTTP 503 后显示错误，重试恢复；390px 无横向溢出，无页面运行异常 |
| 文件检查 | `git diff --check` 通过；`.env`、构建目录和依赖未进入版本管理 |

GitHub Actions 流程已添加，但仓库无远程，未声称远程 CI 已执行。当前本地验证覆盖了其基础构建、API 和队列检查。

已知限制：前端构建提示入口包超过 500kB，主要包含 Ant Design；后续功能路由形成后进行按需拆分。BullMQ 间接依赖 cron-parser v4 有维护状态提示，当前锁文件保留其上游解析版本。当前没有业务表、身份接入、对象存储集成、Milvus、模型或生产业务 Worker；不代表企业安全、性能或 RAG 质量验收通过。P0 业务输入仍待确认。
