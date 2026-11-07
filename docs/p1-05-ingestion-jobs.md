# P1-05 持久任务、重试与恢复

历史验收记录：2026-11-07。后续 P1-06 已接入真实解析器，当前行为见 [解析说明](p1-06-document-parsing.md)。以下记录 P1-05 完成时的阶段边界。

日期：2026-11-07。当前阶段完成上传后的调度与状态机，Worker 实际执行原文件完整性检查，然后进入 waiting_dependency / awaiting_parser。**P1-06 尚未提供解析器；本任务不声称文件已解析、扫描通过、索引完成或可发布。**

## 启动

按 [上传说明](p1-04-uploads-and-versions.md) 配置私有版本化 S3 或启动临时 Moto 开发服务，运行：

```sh
npm ci
npm run infra:up
npm run build:packages
npm run db:migrate
npm run db:seed:dev
npm run storage:init
npm run dev
```

迁移003会为 P1-04 已有版本补建唯一任务，并保留原文、版本与文档指针。Worker 与 API 继续独立运行；INGEST_ENABLED 在配置 DATABASE_URL 时默认启用，也可显式设置 true/false。production 下不启动开发 ping 消费者；必须启用业务处理 Worker，否则拒绝以空进程启动。

## 链路与任务真相

上传 finalize 的同一 PostgreSQL 事务保存版本、Outbox 和 ingestion_job，202 返回真实 job_id、当前状态与 `/api/v1/jobs/:id`，替代 P1-04 的 awaiting_processing 占位契约。同一版本、pipeline_version=intake-v1 只有一个业务任务；不同版本分别处理。相同内容去重复用原任务，不生成新的重复处理任务。

Dispatcher 从 PG 取到期 queued/retry_wait 任务，通过 BullMQ 交付仅含 tenant_id/job_id/revision 的固定消息。标记 Outbox dispatched_at 只是投递记录，不代表业务完成。Redis 不是唯一业务真相：定期重扫 PG 可补偿投递失败、投递与确认之间崩溃及队列数据丢失。生产应限制 Redis 写权限，HTTP 不暴露 BullMQ 内部入口。

## 状态

| 状态 | 含义 | 后续行为 |
|---|---|---|
| queued | 尚未开始执行 | 等待投递与原子领取 |
| running / checking_source | 持有效租约校验固定原文版本 | 心跳、取消与超时检查 |
| retry_wait | 暂时故障或执行中断 | 到 next_run_at 后自动重试 |
| waiting_dependency / awaiting_parser | 原文完整性检查完成，等待解析器 | 不忙循环重试，不标成 succeeded |
| failed | 不可恢复错误或本轮次数耗尽 | 保存死信；允许的错误可显式人工重试 |
| cancelled | 已取消 | 晚到消息不能恢复执行 |
| succeeded | 预留完整流水线终态 | 当前 Worker 不会把只校验文件标为此状态 |

每次状态变更与事件序号同事务保存。历史执行尝试、检查点和死信均在 PostgreSQL；Redis 删除后仍可查询。进度未知时返回 progress=null，界面显示实际阶段和尝试次数，不生成虚假百分比。

## 租约、预算与并发防护

每次原子领取生成独立随机 lease_token，记录 run_no、尝试序号、worker_id、lease_until 和 deadline_at。心跳和提交只接受仍有效的相同 run/lease，使用数据库时间复核；旧 Worker 即使稍后返回，也不能覆盖新租约、重试后的状态或任何终态。API 不返回内部令牌、S3定位、凭据或完整错误堆栈。

默认配置：

| 变量 | 默认 | 范围/作用 |
|---|---:|---|
| INGEST_QUEUE | knowledge-ingestion | 每个数据库环境使用独立队列名 |
| INGEST_MAX_ATTEMPTS | 3 | 每轮1—10次，创建时冻结到任务 |
| INGEST_LEASE_MS | 15000 | 1—120秒，约每三分之一租期续约 |
| INGEST_DEADLINE_MS | 120000 | 1—600秒，单次执行预算 |
| INGEST_RETRY_MS | 1000 | 初始退避100ms—60秒，指数增长与抖动，上限60秒 |
| INGEST_RECONCILE_MS | 10000 | 丢失投递的补发间隔，500ms—300秒 |
| INGEST_POLL_MS | 1000 | 调度与恢复轮询100ms—10秒 |

每个业务 Worker 并发2；可启动多个独立进程。库/文档与成员授权在领取和提交检查点前复核，队列自报身份不会被采用。取消、失去租约和总时限会中断 S3读取；外部调用自身也有超时。Worker 崩溃后，过期租约按同一重试预算恢复，尝试记录标为 interrupted。

source_integrity 检查点只记录确切版本的 SHA，不修改文档最新/发布指针、不把 scan_status 从 pending 变为 clean，也不创建索引。处理旧版本不会覆盖新版本；后续解析/索引步骤仍须继续按不可变版本执行并独立控制发布。

## 故障、死信与手动重试

存储暂时不可用、执行超时、中断等按退避重试；达到本轮上限写入 ingestion_dead_letter 并进入 failed。已拒绝文件或摘要不匹配不会自动重试，需修复来源并上传新版本。权限丢失会停止执行，不继续读取或提交检查点。

手动重试只允许规定错误，要求当前文档 write 权限及任务所有权/显式库管理权。每次新轮次增加 run_no，重置本轮尝试数而保留累计尝试与历史；执行身份绑定到本次重试的服务端认证主体，不从客户端传入。重复 Idempotency-Key 不会再次创建轮次；回放仍重新鉴权。

等待解析器不属于故障，当前 API 不允许用重试绕过缺失的解析器。P1-06 将通过受控服务端集成恢复这些任务，不接受客户端指定处理代码、阶段、脚本或任意网络地址。

## 查询与取消

| 接口 | 当前规则 |
|---|---|
| GET /api/v1/jobs | 状态/kb_id/document_id过滤、签名游标分页；先授权再分页，无隐藏资源总数 |
| GET /api/v1/jobs/:id | 当前状态、最近20次尝试与20条事件，均为可审计操作记录 |
| POST /api/v1/jobs/:id/retry | 当前write + 本人或K；Idempotency-Key；202新轮次 |
| POST /api/v1/jobs/:id/cancel | 当前write/manage + 本人或K；Idempotency-Key；排队/等待任务立即取消，执行中202请求取消，已终态200原状态 |

所有入口继承认证、CSRF 和 Origin。未知/无权资源统一404。普通员工和同库其他编辑者不能仅凭 job_id 查看他人任务；明确获授的库管理者可管理范围内任务，管理员角色没有全局旁路。已经发给客户端的内容无法收回；任务取消不会删除已上传的原文件或版本。

前端在文档的“查看版本”下显示处理任务、实时轮询状态、重试、取消和执行记录。只读成员不显示管理任务入口；失去权限后清空任务内容。时间使用北京时间显示，未知进度不显示伪造百分比。

## 验证

```sh
npm run check
npm run test:auth
npm run test:resources
npm run test:uploads
npm run test:ingestion
```

任务测试使用独立 schema、S3桶、Redis会话命名空间及 BullMQ 队列，不影响开发任务。覆盖旧版本迁移补建、投递丢失、重复消息、租约心跳、真实 SIGKILL 后恢复、旧租约晚到、退避耗尽与死信、幂等人工重试、执行中取消、权限撤销、固定执行预算、永久错误与跨版本指针不变。扫描、解析、分块、索引和生产灾备均不是本阶段已验收能力。

### 本次实际验收

- 全工作区类型检查与构建通过，基础测试2项；身份12项、资源15项、上传17项及任务12项通过，合计58项自动化测试。
- 任务测试包含真实 Worker SIGKILL、租约恢复/晚到写回拒绝、Redis交付丢失补发、幂等人工重试、自动退避耗尽、执行中取消、心跳续约、截止时间、权限/安全状态变化及永久错误拦截。
- Playwright + 系统 Chromium 验证失败状态与执行记录、修复存储后的界面手动重试、等待解析器的真实状态、取消及390px移动布局，无页面运行异常；扫描状态仍为 pending，发布指针仍为空。
- `npm ci` 按锁文件重新安装成功，独立 Worker 的真实 ping 队列往返通过；迁移补建与重复应用通过，`git diff --check` 通过。
- GitHub Actions 已接入同一任务套件，远程结果以实际 Actions 记录为准。前端仍有入口包大小提示；解析、扫描、索引、发布与生产灾备尚待后续任务验收。
