# P1-04 上传与不可变文档版本

日期：2026-11-07。已实现受控原文件上传、不可变版本、重复提交处理与授权下载。解析、杀毒扫描、索引、发布和后台重试状态机属于后续任务；当前新版本一律保持草稿、scan_status=pending，不参与检索。

## 启动与对象存储

现有 PostgreSQL/Redis 启动方式不变。先安装依赖、构建共享包并应用新增迁移：

```sh
npm ci
npm run infra:up
npm run build:packages
npm run db:migrate
npm run db:seed:dev
```

生产或需要长期保留文件时，使用组织批准的私有 S3 或兼容服务，设置 `.env` 中的 S3_BUCKET、S3_REGION、可选 S3_ENDPOINT 及服务端凭据。必须启用桶版本化、阻止公共访问，并限制应用凭据到专用桶。原文件按精确对象 VersionId 读取，不能用“当前同名对象”替代。S3 凭据不会发送给浏览器；也可以使用 AWS SDK 的默认工作负载身份链。

### 可选的本地协议模拟服务

没有现成 S3 时，可使用 Python 3.11+ 与锁定的 Moto 5.1.11 开发服务，不需要拉取大型对象存储镜像：

```sh
python3 -m venv .venv-storage
. .venv-storage/bin/activate
python -m pip install -r requirements-dev-storage.txt
npm run storage:dev
```

保持该终端运行，另一个终端执行：

```sh
npm run storage:init
npm run dev
```

`storage:init` 仅允许 development/test，显式创建本地测试桶、启用版本化与公共访问阻断，不在 API 启动时自动操作桶。Moto 是独立的 S3 协议模拟器，默认数据在进程内存中，停止模拟器会丢失文件，不能用于生产或长期资料；数据库中的版本记录不会因此伪造文件存在，读取会返回503。真实持久性由所接入的 S3 服务承担。

本次云环境的 MinIO 镜像访问不可用，LocalStack 镜像解包超过可用磁盘，因此采用轻量原生模拟器完成开发协议验证；应用存储适配器仍是标准 AWS SDK S3。

## 已实现流程

1. 知识库“文档与上传”入口显示当前主体可见的文档。具有 write 的知识运营可选择新文档或已有文档的新版本。
2. 浏览器计算 SHA-256，POST `/api/v1/upload-tickets`，提交 kb_id、可选 document_id、filename、size、mime、sha256；必须带 Idempotency-Key。
3. 201 返回票据、有效期与同源 PUT `/api/v1/upload-tickets/:id/content`。上传始终经过身份、CSRF 和当前资源授权，不产生可转发的公开上传链接。
4. 服务端逐块接收并限制字节数，校验真实长度、SHA-256 和基础格式。写入仅由服务端生成的唯一 key，使用 S3 If-None-Match 与明确 VersionId 固定内容。
5. POST `/api/v1/upload-tickets/:id/finalize`（Idempotency-Key、JSON sha256），重新核验归属、当前权限、有效期、版本化对象真实字节与摘要。
6. 同一 PostgreSQL 事务登记 source_asset、不可变 document_version、latest_version_id、完成票据、document.version_created Outbox 与变更审计。
7. 202 返回 document_id、version_id、version_no、status=awaiting_processing、指向版本元数据的 status_url。**P1-05 尚未创建运行队列，本阶段不返回虚构 job_id/generation_id 或声称已解析。**

GET `/api/v1/upload-tickets/:id` 可查询本人票据状态。中断后可再次上传同一票据；界面会保留当前尝试的幂等键并重试。刷新整个浏览器后需重新选择文件；若需要恢复原尝试，可用已返回票据 ID 查询接口，当前尚未实现跨刷新上传历史 UI。

## 限额与校验

默认单文件10MiB，可通过 UPLOAD_MAX_BYTES 配置至最多50MiB；每组织在用源文件加有效票据保留量默认1GiB（UPLOAD_TENANT_BYTES），同时有效票据默认20张（UPLOAD_ACTIVE_TICKETS），有效期默认600秒（UPLOAD_TTL_SECONDS，最大3600秒）。额度在组织级事务锁内检查，防止并发超订。每个 API 进程同时最多接收4个文件，接收超时30秒，超过限制返回413/429。

首批接受 UTF-8 TXT、Markdown 和以 `%PDF-` 开头的 PDF；文件名禁止路径分隔符与控制字符，键不包含用户文件名。元数据 MIME 与扩展名须匹配，上传 Content-Type 须匹配票据，文本拒绝非法 UTF-8/NUL/明显二进制签名。仅做基础格式嗅探，不把头部校验声称为完整 PDF 解析或病毒扫描。DOCX 等格式待隔离解析器接入后开放。

过大413、不支持415、内容/摘要不符422、过期410、未上传或文档已变化409。其他租户、非票据所有者、没有目标写权限者统一404。传入 object_key、对象版本号或 tenant_id 等额外字段会被拒绝，服务端不信任客户端存储定位。

## 版本与重试保证

- 每次替换绑定服务器看到的文档修订号；旧票据晚到时若已有新版本，finalize 返回409，不能覆盖最新上传指针。
- 同一票据并发 finalize 只产生一个版本、一个 Outbox 事件。重复内容在同一文档内复用已有版本，不移动最新指针；恢复历史版本的发布操作不属于此任务。
- 新业务文档即使字节相同也保留不同 document_id、版本和源对象，不按哈希跨文档/租户合并权限。
- 版本内容字段由数据库触发器禁止修改；源对象定位、文件名、大小、MIME、SHA 不可修改，扫描状态可由后续受控流水线更新。组合外键阻止最新指针指向其他文档版本。
- S3 与 PostgreSQL 不承诺跨系统原子提交。若 S3 写入成功而事务失败，重试通过条件写和实际字节校验恢复同一个对象版本，不重复创建文件版本。
- `npm run uploads:cleanup -- TENANT_UUID` 显式清理该组织过期或重复票据产生的无引用对象。每批最多100张，跳过在途锁定票据；不会删除任何 source_asset 固定引用的对象版本。可重复运行，票据元数据仍保留供追踪。保留期治理和定时任务将在后续阶段实施。

## 原文件与版本访问

GET `/api/v1/documents/:id/versions` 提供签名游标分页；GET `/api/v1/documents/:id/versions/:versionId` 返回不可变元数据、是否最新/已发布及扫描状态，不暴露对象 key、VersionId 或凭据。

GET `/api/v1/documents/:id/versions/:versionId/content` 要求 read + download，复用统一权限，并检查版本确属本文档。未发布/待检查版本仅有 write/publish 的维护者可读；只读成员看不到草稿、待检查版本或其数量。拒绝状态文件不能下载。

下载固定读取 S3 VersionId 并验证真实字节；返回 attachment、application/octet-stream、nosniff 和 no-store，不内联显示 PDF/HTML。支持单区间 Range 与206/416；每64KiB重新检查当前身份、ACL和版本可见性，撤权提交后停止后续分块，已经下载的部分无法撤回。

所有版本写入都保留当前文档 ACL 和所属库，不修改已发布指针。后续 Worker 只能按不可变版本处理，发布时仍需独立检查当前版本、权限和索引代际，不能将过期任务结果写回新版本。

## 验证入口

```sh
npm run check
npm run test:auth
npm run test:resources
npm run test:uploads
```

上传集成测试使用真实 HTTP、PostgreSQL、Redis 与独立 Moto S3 服务，随机 schema、桶和 Redis 命名空间，结束只清理自己的测试资源。覆盖元数据与字节校验、分块超限、中断重试、并发 finalize、固定对象版本、匿名存储拒绝、跨组织与本人约束、草稿隐藏、不可变数据库字段、旧上传晚到、并发额度、S3/事务故障恢复、孤儿清理、Range与下载中途撤权。CI 启动开发 S3 服务后执行相同协议验证；这不替代真实供应商兼容性、灾备或生产安全验收。

### 本次实际验收

- `npm run check`：全工作区类型检查和构建通过，基础测试2项通过；最终移动布局调整后前端再次构建通过。
- 身份12项、资源15项、上传17项测试通过，合计46项。上传测试还验证了只读成员仅能看到 clean 的已发布版本、拒绝状态不可下载以及上传后撤销写权限不能 finalize。
- Playwright + 系统 Chromium：新建文档、v1/v2 替换、相同内容不增版、两个历史原文精确下载、不支持格式提示、只读成员草稿隔离及390px移动布局通过，无页面运行异常。
- 新迁移与重复迁移、开发桶初始化通过。前端产物中未发现服务端 S3 凭据配置标识；`git diff --check` 通过。CI 已更新，远程结果以实际 Actions 记录为准。
- 前端入口约1.13MB、gzip约351KB，仍有大包提示，后续按路由拆分。真实持久 S3、供应商兼容性、杀毒扫描与解析索引需要在相应环境/任务继续验收。
