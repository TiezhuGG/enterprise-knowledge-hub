# P1-01 开发入口

实现日期：2026-11-07。已扩展 P1-02 开发身份与 P1-03 知识库权限闭环，见 [身份说明](p1-02-authentication.md)；不代表 RAG 或企业上线验收完成。

## 环境与启动

使用 Node **24.22.1**、npm **11.9.0**（`.nvmrc` / `packageManager`），Docker Engine 与 Compose v2。Node 依赖精确解析记录在 `package-lock.json`；CI 使用 `npm ci`。

在仓库根目录执行：

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run build:packages
npm run db:migrate
npm run db:seed:dev
npm run dev
```

打开 http://127.0.0.1:5173 。API 存活检查为 http://127.0.0.1:3000/api/v1/health/live 。Vite 将 `/api` 代理到 API，无需开放跨域；修改 API_PORT 后代理跟随，使用远程 API 时设置服务端配置 API_PROXY_TARGET。页面不会显示数据库或模型已就绪。

`npm run dev` 先构建，再分别监视 API/Worker 的 TypeScript 和输出文件，Web 使用 Vite 热更新。修改共享契约或配置包后重启该命令。`.env` 在进程启动时读取，修改后重启。

## 服务与边界

| 目录 | 职责 | 当前实现 |
|---|---|---|
| apps/web | React + TypeScript + Vite + Ant Design | 中文起始页、真实 API 检查、超时与重试 |
| apps/api | NestJS HTTP 进程 | 存活、开发认证与知识库/文档权限接口 |
| apps/worker | 独立 NestJS 应用上下文 + BullMQ | 仅 development-smoke 队列的 ping 任务 |
| packages/contracts | 前后端共享的数据契约 | 存活响应、开发队列名称与输入 |
| packages/config | 服务端配置入口 | API 与 Redis 配置校验，不导出给前端 |

API 不依赖 Worker 进程，可独立启动、停止和部署；Worker 只连接 Redis，不引用 API。开发 Worker 在 NODE_ENV=production 下拒绝运行。后续 P1-05 增加持久化业务任务状态、幂等和重试；当前 ping 不写业务数据，也不能作为生产解析器。

```sh
npm run build
npm run start -w @zhiheng/api
# 另一个终端
npm run start -w @zhiheng/worker
# 第三个终端，验证真实队列往返
npm run smoke:queue
```

Worker 可启动多个进程消费同一开发队列。生产并发、幂等与业务正确性尚未验证。生产前端需要反向代理 `/api` 到 API；`vite preview` 仅预览静态产物，不提供生产反向代理。

## 本地与测试存储

Compose 提供 PostgreSQL **17.6** 和 Redis **7.4.6**，固定版本镜像、持久卷、健康检查，仅绑定回环地址。数据库是未来业务真相源；资源迁移已建立成员、知识库、文档归属与 ACL；开发会话由 Redis 保存。Redis 启用 AOF，仍不作为唯一业务记录。测试使用独立 Compose 项目和端口，避免覆盖开发数据。

S3 接口配置样例已保留；P1-04 选择组织批准的 S3 服务或本地兼容实现后接入，不默认引入未经许可确认的对象存储。Milvus 在 P1-08 接入，Neo4j 在 P3 接入；本任务不拉起所有未来服务。无需模型密钥即可启动骨架。

`.env.example` 只有公开的本地开发占位凭据，`.env` 与变体已忽略。任何真实凭据只保存在本地环境或秘密管理服务。`VITE_*` 会进入浏览器，禁止放服务密钥。Compose 不用于生产或公网暴露；不要把生产数据导入开发环境。

```sh
npm run infra:down
```

此命令保留持久卷。仅在明确需要清空本地开发数据时自行执行 `docker compose down -v`，该命令不可恢复。

## 验证与 CI

```sh
npm run check
npm run smoke:queue
```

`check` 包括全工作区类型检查、构建、配置反例与真实 API 启动/关闭/同端口重启测试。队列 smoke 要求 Redis 和独立 Worker 已启动，校验随机 nonce 的实际往返，超时返回失败。CI 安装锁定依赖，执行 check，启动 Compose，再验证 Worker 消费和重启后的队列消费。

常见故障：Web 状态失败时先直接访问存活端点；端口冲突修改 `.env`；Worker 无 ready 日志时检查 `docker compose ps` 与 Redis 配置；Docker 不可用时先恢复 Docker，API 与 Web 可单独开发。日志不输出连接串、密码或任务正文。

知识库与角色配置见 [资源与权限说明](p1-03-resources-and-access.md)。

## 尚待业务确认

试点部门、脱敏数据、身份源、模型出站边界、对象存储许可与生产基础设施仍待确认。P1-01 可独立推进，不把 P0 业务评审标记为通过。P1-02 已提供明确标记的开发身份，企业 OIDC 集成仍需确认实际身份方案。
