# P1-02 登录与服务端身份上下文

实现日期：2026-11-07。当前交付开发身份闭环；企业 OIDC 身份提供方尚未选定，生产登录未启用。

## 启动开发登录

先按 [开发说明](development.md) 启动 Redis。`.env.example` 中开发登录默认关闭。在本地 `.env` 设置：

```dotenv
NODE_ENV=development
DEV_AUTH_ENABLED=true
AUTH_ORIGIN=http://127.0.0.1:5173
SESSION_TTL_SECONDS=28800
```

使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 在自己的终端生成随机口令，写入 `.env` 的 `DEV_AUTH_SECRET`。不要提交或发送真实口令。重启 `npm run dev`，在前端“开发访问口令”输入该值即可登录。该共享口令只用于隔离开发环境中的固定测试身份，不是企业账号密码协议。

`AUTH_ORIGIN` 必须是浏览器实际使用的完整 origin（协议、域名及端口，不带路径和末尾斜线），否则登录和退出返回 403。默认仅绑定回环地址。若使用云预览域名，应配置该预览 origin；公网部署仍必须使用正式身份源与 HTTPS。

## 接口与状态

| 接口 | 行为 |
|---|---|
| POST `/api/v1/auth/dev-login` | 仅显式启用时可用；JSON `{account, secret}`；成功 200，设置 Cookie 并返回当前会话 |
| GET `/api/v1/auth/session` | 200 `{data: {identity, display_name, expires_at, csrf_token}}`；缺失、过期、无效身份返回 401 |
| POST `/api/v1/auth/logout` | 校验 Origin 与有效会话的 X-CSRF-Token；删除服务端会话并清 Cookie；重复退出 204 |
| GET `/api/v1/health/live` | 公开存活检查；不表示 Redis 或登录可用 |

开发账户 `employee` 与 `other` 分别绑定两个不同的虚构组织。前端使用 `employee`；`other` 仅供隔离测试。角色均为 employee，不提供客户端选择管理员或租户的能力。额外登录参数一律 400；会话查询中的自报组织/用户字段不会改变身份。

## 信任边界

- 全局 AuthGuard 默认要求认证，仅存活、开发登录及幂等退出显式公开；后续业务控制器自动继承保护。未知路由仍为 404。
- Cookie 为随机 256-bit opaque token，HttpOnly、SameSite=Lax、Path=/api/v1；浏览器中不使用 localStorage 或 JS 可读 Session secret。当前开发模式使用 HTTP，Cookie 不标 Secure；正式 HTTPS Cookie 属未来 OIDC 集成范围。
- Redis key 只保存 token 的 SHA-256；会话正文含固定账户引用、CSRF token 和绝对到期时间，不保存登录口令。TTL 默认 8 小时，上限 24 小时，不自动续期。重登轮换会话并撤销旧 Cookie。
- 服务端每次验证会话都从开发身份适配器重新解析 actor_id、tenant_id、membership_id、role 和 capabilities，绑定到 `request.identity`。X-Tenant-Id、X-User-Id、Bearer、请求正文和查询参数均不能授予权限。
- `DEV_DISABLED_ACCOUNTS=employee,other` 可停止接受相应开发账户（重启 API 生效）。这只是开发名单，不等同于生产成员目录与撤权事件；正式成员、资源 ACL、权限版本在后续任务实施。
- 浏览器写请求要求准确 Origin 和会话 CSRF token；开发登录也要求 Origin，防止登录 CSRF。每个连接来源地址在 Redis 中最多 10 次登录尝试/分钟，不信任客户端 X-Forwarded-For。代理场景的共享来源可能共用限额。
- Redis 不可用返回 503，禁止退回内存或信任客户端身份。API 可以独立启动；Redis 故障不会把存活检查误报为身份系统健康。
- 响应使用 no-store 和服务端 X-Request-Id；登录/退出日志只含操作、主体、组织和 request_id，不打印口令、Cookie、CSRF token 或请求正文。这是基础安全事件日志，正式持久审计仍待后续任务。

## 验证

```sh
npm run check
npm run infra:up
npm run test:auth
```

集成测试使用真实 HTTP 与 Redis、随机命名空间，测试结束仅清理该命名空间，不清空开发数据库。覆盖未登录、伪造凭据、错误 Origin/CSRF、租户篡改、跨组织身份、Cookie 轮换、退出与重放、过期、停用成员、API 重启、限流、Redis 故障和日志脱敏。CI 在 Compose 就绪后执行。

生产模式拒绝启用开发认证，即使误设密钥也不能启动开发身份入口。进入生产前需接入企业批准的 OIDC、可信成员数据源、HTTPS/Secure Cookie、持久撤权与审计；本任务没有伪造这些能力已完成。

### 本次实际验收

- `npm run check`：全工作区类型检查与构建通过，基础 API/配置测试 2 项通过。
- `npm run test:auth`：12 项通过，包含真实 HTTP/Redis 生命周期与安全反例。
- Playwright + 系统 Chromium：错误口令、登录成功、刷新保持会话、HttpOnly/无 localStorage 凭据、退出后重放拒绝、真实到期提示、390px 移动布局通过，无页面运行异常。
- `git diff --check` 通过。前端入口包仍有超过 500kB 的构建提示，后续按功能路由拆分；不影响上述验证。
- CI 已更新，远程执行结果需以 GitHub Actions 为准，本地通过不等同于远程已运行。
