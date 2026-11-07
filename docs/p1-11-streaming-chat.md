# P1-11 流式问答、历史与证据 UI

日期：2026-11-07。已实现私有会话、持久运行与事件、SSE阶段/摘录输出、停止、断线恢复、引用定位和简单反馈。沿用P1-10原文摘录基线，用户尚未部署本地生成服务，默认关闭生成；协议夹具通过不等于真实模型质量验收。

## 一次提交与多次观察

新增迁移008：conversation、chat_run、chat_event、chat_feedback、chat_stream_lease。会话归属固定租户与成员，运行外键同时绑定会话及成员；问题/回答消息ID固定。没有管理员浏览他人聊天的旁路。

创建会话和运行均要求8—128字符的Idempotency-Key，服务端保存键/载荷摘要。同成员同键同载荷返回原记录，不重新执行；不同载荷409。幂等记录不因刷新或重新连接过期，已删除会话的旧键不能复活会话。显式“重新生成”使用新键，保留parent_run_id，重新检索当前授权资料，不覆盖旧消息。

当前同会话最多1个活跃运行，同成员跨会话也最多1个，后者通过PG事务锁跨API实例约束；与P1-10的单成员在途保护保持一致。不同成员还受API进程内最多2个模型问答的限制。旧 `/answers` 保留兼容性，仍为原来的非持久接口；页面已改用新chat-runs接口，不把旧接口宣称为跨实例统一配额服务。

**执行在创建运行的API进程后台进行，与浏览器连接分离。** POST事务保存run与run.started，再启动一次执行；GET、SSE、历史与重连都不启动执行。断网、刷新或Session退出不自动取消后台任务；成员/资料权限变化会终止受影响任务。API进程丢失后不自动重新调用可能已计费的模型：95秒deadline到期后的读取或下一次提交会将遗留运行明确置为failed/EXECUTION_INTERRUPTED。存活进程也有95秒协作预算。当前不是独立持久聊天Worker或高可用自动接管，用户可显式重新生成。

## 缓冲校验与终态

模型调用仍为P1-10非流式OpenAI兼容请求。SSE实时发送实际阶段：请求已登记、检索授权资料、选择原文摘录、核验引用与权限。**采用缓冲模式**：完整生成内容通过逐字引用和所有输入依赖的授权校验后，才将引用与摘录分段事件一起提交到PG。摘录按最多64个Unicode码点分段，没有人为逐字延时，不转发尚未校验的模型token。

事件日志只保存来源ID、claim序号和片段区间等重建参数，不复制模型原始输出。结果与完整输入依赖保存在私有运行记录；读取每个事件批次时从当前授权快照重建展示内容。模型未知来源、改写、截断和上游失败没有answer.delta，终态为run.failed；无证据或不足是明确的拒答结果，不伪造答案。

PG运行行锁及条件更新决定唯一终态。停止先记录取消和run.cancelled，再向在途fetch传播abort；迟到响应不能覆盖cancelled。若completed先提交，停止返回completed，界面显示实际结果。终态运行及既有事件禁止UPDATE。停止确认的是产品不再追加答案，无法保证本地模型立即停止计算或不再产生费用。

每轮问题独立检索，不自动把历史对话当作新一轮模型上下文；追问需写明主题。当前只提供“有帮助/无帮助”覆盖式反馈，没有开放自由文本或完整评测管理。

## API

所有接口要求当前会话，写操作要求Origin与CSRF。使用private/no-store、Vary Cookie/Authorization。

| 方法与路径 | 行为 |
|---|---|
| POST /conversations | title可省略，返回201；要求Idempotency-Key |
| GET /conversations | 本人会话，limit/q/cursor分页 |
| PATCH /conversations/:id | title纯文本，If-Match为 `"conversation:UUID:row_version"` |
| DELETE /conversations/:id | 200逻辑隐藏，同事务取消未终止运行；不声称已物理清除 |
| GET /conversations/:id/messages | 最新运行优先，limit/cursor分页；每项包含固定问题/回答消息ID、问题与运行快照 |
| POST /chat-runs | conversation_id、message及P1-09检索参数，202；要求Idempotency-Key |
| GET /chat-runs/:id | 当前状态、阶段、消息ID、最终answer、usage所在answer、last_event_id及事件/取消URL |
| GET /chat-runs/:id/events | SSE，无创建运行或调用模型的副作用 |
| POST /chat-runs/:id/cancel | 空JSON，200已提交终态；完成已获终态则返回原结果 |
| POST /chat-runs/:id/regenerate | 空JSON，新Idempotency-Key，202新运行及parent_run_id |
| POST /chat-runs/:id/feedback | value=helpful/unhelpful，仅可访问的completed回答；本人单票upsert |

messages首版返回按运行组成的问题/回答对，不宣称已实现独立消息编辑或多轮问题改写。会话与消息游标签名绑定主体/权限版本、查询与会话，不能跨会话/成员重用。

## SSE协议与恢复

事件类型为run.started、run.progress、citation.upsert、answer.delta、run.completed、run.failed、run.cancelled。持久seq从1严格递增，客户端按(run_id,seq)去重，未知运行/非法序号/缺口会恢复快照，不拼接成完整答案。仅展示操作阶段，不展示或保存模型隐藏推理。

首次从0读取；支持Last-Event-ID或after，若同时提供必须数值一致，超前、非法或未知查询字段400。每批最多16事件，每批重新验证Session、成员及所有来源；客户端处理终态后主动关闭EventSource。15秒注释心跳不占seq；连接最多120秒，断开后可沿原游标续读。禁用代理缓冲，写缓冲不足时关闭连接，客户端按已确认seq重放。

每成员最多3个事件连接，使用PG租约跨API实例计数，15秒到期，正常断开释放。事件可回放窗口24小时，过期发无持久ID的stream.reset_required及status_url；客户端读取快照。当前为逻辑窗口，未增加物理清理调度，组织会话保留/清理策略仍待确定。

Session失效发stream.auth_required；权限撤回发stream.access_revoked；依赖不可用发stream.unavailable。控制事件不冒充成功终态。客户端先清空旧内容再恢复当前快照；网络重连只GET原run，不POST新run。

## 历史与引用权限

运行保存所有发送给生成模型的证据依赖，包括最终未引用的资料。历史、快照、SSE重放及反馈入口都重新验证当前成员/ACL、确切发布版本和代际、clean/active/ready及原文摘要/索引收据。任何输入依赖失效，回答整体返回restricted占位，answer=null，不返回受限标题、正文或引用。

历史所用服务端签名证据凭证可在内部重新核验后续签10分钟引用，避免回答因旧citation_id到期永久丢失；公开citation端点仍拒绝过期凭证。请求参数不能提供历史依赖或绕过到期检查。签名密钥轮换导致旧凭证不能核验时保持受限，后续迁移/轮换策略需专门设计。

点击来源从公开引用端点实时复核，展示标题、确切版本、章节、PDF页码/文本行号/Word结构位置，并高亮该条连续原文；焦点移至来源面板。下载仍独立校验download权限。已发送到浏览器/模型的字节无法追溯收回，撤权约束之后的读取与输出。

## 页面行为与验证

页面提供历史会话、加载更早消息、恢复当前状态、停止、重新生成、原文定位/下载和反馈。输入支持Ctrl/Command+Enter提交、Enter换行；操作使用原生按钮/Ant Design控件，阶段用role=status，错误用role=alert，来源面板可聚焦。390宽度下问题和引用链接换行，无横向溢出。

浏览器sessionStorage只保存当前会话ID和待确认创建会话的幂等键，不缓存问题、回答、来源正文或会话凭据。提交响应丢失时保留内存中的原载荷与键，“重试同次提交”复用同键；刷新后只恢复已保存会话历史，不自动重新提交问题。切换会话会使旧异步回调失效，来源复核采用请求序号，分页按ID去重。

```sh
npm run db:migrate
npm run check
INDEX_PYTHON=/path/to/index-venv/bin/python npm run test:chat
```

新增4项客户端序号/重放测试，以及19项聊天集成测试（含父测试）。使用真实PG、Redis、开发版本化S3、Worker与Milvus Lite，生成/嵌入模型为明确标记的本地HTTP夹具。覆盖双API实例幂等、活跃配额、断线无重复调用、取消/完成唯一终态、已撤权历史与SSE隐藏、过期引用续签、Session撤销、来源换版及重新生成、坏输出失败、事件窗口过期、进程SIGKILL后无模型重试、删除后不可复活。进程丢失测试以受信SQL推进deadline，未等待95秒实时时间。

Chromium实际验证：键盘提交、阶段可见、生成期间刷新、离线期间后台完成后恢复、模型调用计数与run数量不增加、停止、反馈刷新保存、来源高亮与下载、撤权后历史清空、桌面/390宽度阅读。无页面脚本错误。截图为当前工作区临时产物：`/tmp/zhiheng-p1-11.png`、`/tmp/zhiheng-p1-11-mobile.png`。

真实中文语义质量、模型上下文容量、吞吐/延迟、生产代理SSE配置、独立执行Worker/接管和组织保留策略均未由上述夹具验收；保持既有P1-08/P1-10模型实测待办。

本轮结果：全工作区类型检查、生产构建和迁移通过；单元/基础41项、认证至检索既有集成100项、基线问答15项、聊天19项，合计175项通过。生成与嵌入采用受控协议夹具；未把上述结果作为真实模型准确率。
