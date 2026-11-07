# P1-03 知识库资源与权限服务

实现日期：2026-11-07。本任务提供持久化资源、成员、组授权与统一策略；上传、文档版本、实际文件下载和检索在后续任务接入。

## 开发启动

Node 24 是必需环境：共享契约包使用 ESM，API 与 Worker 通过 Node 24 的 require(ESM) 互操作消费它，前端直接消费 ESM。

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run build:packages
npm run db:migrate
npm run db:seed:dev
npm run dev
```

按照 [身份说明](p1-02-authentication.md) 在本地 `.env` 启用开发登录并设置随机 `DEV_AUTH_SECRET`，登录时选择开发测试身份。`DATABASE_URL` 指向 PostgreSQL 真相源。生产需独立随机 `RESOURCE_CURSOR_SECRET`（至少32字符）；开发和测试可回退到 `DEV_AUTH_SECRET`。更换游标签名密钥会使旧分页游标失效，刷新列表即可。

迁移不会在 API 启动时偷偷执行。`db:migrate` 使用事务、迁移锁和 SHA-256 校验，重复运行不会重建已有数据；后续变更应添加新迁移，不能改写已应用的 SQL。`db:seed:dev` 仅允许 development/test，显式创建虚构组织和成员，重复运行保留既有角色和停用状态，不恢复已撤销权限。

| 开发账号 | 角色 | 成员稳定标识 | 组织 |
|---|---|---|---|
| employee | 员工 | `30000000-0000-4000-8000-000000000001` | 开发空间 |
| operator | 知识运营，可创建库 | `30000000-0000-4000-8000-000000000003` | 开发空间 |
| admin | 工作空间管理员，可创建库 | `30000000-0000-4000-8000-000000000004` | 开发空间 |
| other | 员工 | `30000000-0000-4000-8000-000000000002` | 隔离空间 |

这些账号共用本地开发口令，只适用于隔离开发环境；企业身份接入仍未实现。选择角色只是选择固定开发账号，不能通过客户端指定任意租户或角色。成员和组的正式管理页面/API 尚未实施，当前种子与测试 SQL 提供开发数据。

## 已实现接口

所有路径带 `/api/v1` 前缀，继承认证、CSRF、Origin 和 no-store。

| 方法与资源 | 当前能力 |
|---|---|
| GET /knowledge-bases | 当前主体可见的知识库，支持 q/status/limit/cursor |
| POST /knowledge-bases | 创建默认私有库，显式授予创建者管理权限；要求 Idempotency-Key |
| GET/PATCH /knowledge-bases/:id | 读取配置与能力；修改需 manage 和 If-Match |
| GET/PUT /knowledge-bases/:id/acl | 读取和完整替换授权；需 manage_acl，PUT 要求 If-Match |
| GET /knowledge-bases/:id/documents | 仅列出可见文档元数据，先过滤权限再分页 |
| GET /documents/:id | 受控文档元数据与当前能力 |
| GET/PUT /documents/:id/acl | 文档继承/收紧规则；要求库和文档的 manage_acl，更新需 If-Match |

ACL 是最多100条规则的有界完整配置；GET 返回完整规则，不枚举全组织成员。规则使用 `{principal_type: "member"|"group", principal_id, actions}`。动作包括 read/download/write/publish/delete/manage/manage_acl；组为稳定组 ID，暂不支持嵌套组。知识库发布策略暂只接受 manual，避免把尚未实现的自动发布能力展示为可用。

API 返回 ETag，更新缺少 If-Match 为428，过期版本为412。ACL 更新同步递增 row_version 与 policy_version；文档 ETag 同时包含父库 policy_version。禁止移除最后一位有效资源管理者；限制文档也必须保留父库获授权的有效管理者。不可见资源统一404，不返回原名称或拥有者。

## 唯一授权依据

`packages/resources` 是不依赖 NestJS 的服务端共享包，导出 `ResourceStore`，API 通过薄控制器调用。后续 Worker、检索、原文/引用下载必须复用 `authorizeKnowledgeBase` / `authorizeDocument`，不能根据客户端参数、模型输出或旧会话能力自行判断。当前尚无下载/检索业务入口，不声称这些未来入口已通过端到端验收。

每次操作均验证 PostgreSQL 中的租户状态、actor/member 绑定、成员状态与当前角色；客户端传来的 role/capabilities 无法改变结果。配置 DATABASE_URL 时，登录和每次会话查询也复核数据库成员关系。数据库不配置时仅允许独立的 P1-02 身份夹具演示，资源访问始终503，不会降级为内存知识库。

角色能力与资源 ACL 取交集：员工/审计员最多读和下载；知识运营/管理员可在明确获授资源内执行写、发布或管理操作。管理员没有隐式全站阅读权，owner_id 也不是绕过 ACL 的后门。创建者授权以真实 ACL 行保存。

文档权限先受父库约束，再与 restricted 文档规则取交集。库外授权、跨租户引用、仅在父库有写但文档只有发布等不相交授权都不能扩大访问。草稿和归档文档只对同时具有对应编辑/管理权限的主体显示；已删除资源不可见，归档库仅保留获授的库管理能力，不提供内容读取。当前 document 表只建立归属和权限元数据，实际发布指针和版本约束将在后续文档任务补齐；应用没有伪造可发布的文件。

数据库使用含 tenant_id 的组合外键，约束知识库归属、创建者、成员、组和文档引用。ACL 资源与主体各二选一，数据库也做 CHECK。当前不宣称 PostgreSQL RLS 已验收；租户限定 SQL、组合外键和统一策略构成此任务的隔离边界。

## 一致性、分页与故障

- 创建知识库、初始 ACL、幂等记录和变更审计在同一个事务提交。相同主体/幂等键/规范化参数只创建一个库，包括并发重试；同键不同内容409。回放前重新验证权限，不会恢复已移交的管理权。
- ACL 和配置更新锁定资源行、复核 ETag，避免覆盖并发修改。角色与成员状态在业务事务中重新读取；无授权缓存。撤权提交后新的请求和新的共享策略调用立即拒绝，已经发到客户端的内容无法撤回。
- 列表在 SQL 内过滤主体、角色、父库与文档状态后再 LIMIT，不返回隐藏资源总数。游标带 HMAC 签名，并绑定组织、成员、权限版本、角色、资源范围、查询和页大小。权限变化后每页重新过滤，不承诺跨页快照。时间以毫秒存储，结合 UUID 确定稳定排序。
- PostgreSQL 不可用返回503，拒绝访问，不信任客户端或降级到演示数据；Redis 会话故障仍按 P1-02 返回503。
- 当前 `resource_audit` 只记录服务端主体、组织、资源ID、操作、request_id 和时间，与变更原子写入；不写密钥、全文或 ACL 正文。完整审计查询、留存和告警属于后续治理任务。
- 不提供成员停用、组管理或文档发布的公开写入口。未来这些入口也必须约束最后管理者、权限版本与生命周期，不能把开发 SQL 当成生产管理接口。

## 验证入口

```sh
npm run check
npm run test:auth
npm run test:resources
```

资源测试使用真实 PostgreSQL、Redis 和独立 API，创建随机测试 schema，迁移两次，结束只删除自己的 schema 和 Redis 命名空间；不清空开发表。覆盖默认私有、跨组织与管理员无旁路、角色/ACL 交集、成员/组撤权、文档收紧、草稿隐藏、签名游标、权限过滤后分页、并发幂等、ETag 冲突、最后管理者、组合外键、服务重启与数据库故障。测试还使用第二个独立 ResourceStore 调用共享授权，以验证跨进程消费路径的策略语义。

### 本次实际验收

- `npm run check`：全工作区类型检查和构建通过，基础测试2项通过；最终前端调整后再次构建通过。
- `npm run test:auth`：12项通过；`npm run test:resources`：15项通过，共29项自动化测试。
- Playwright + 系统 Chromium：运营新建/编辑、默认私有、员工只读界面、授权后可见、撤权后旧入口拒绝、最后管理者拦截、管理员无内容旁路、390px布局均通过，无页面运行异常。
- `npm ci` 按锁文件安装成功；共享契约切换 ESM 后，新 Worker 启动与真实队列 smoke 往返通过。
- 开发数据库迁移、种子与重复迁移验证通过；`git diff --check` 通过。远程 CI 结果以 GitHub Actions 实际运行记录为准。
- 前端入口包约1.12MB（gzip约348KB），仍有大包提示，后续按功能路由拆分。企业 OIDC、RLS 实验、文件内容/版本、下载、检索、流式撤权及完整审计尚未实现。

共享授权只覆盖本任务的权限与元数据生命周期。后续检索除复用该服务外，必须再验证文档处于 active、当前已发布版本与索引代际匹配，不能把可管理草稿/归档元数据等同于可用于回答的证据。
