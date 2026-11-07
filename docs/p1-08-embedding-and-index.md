# P1-08 嵌入与向量索引接入

日期：2026-11-07。适配层、缓存账本、索引代际、真实 Milvus 读写和索引界面已实现。**真实中文模型验收尚未完成**：用户已选择本地 BGE-small-zh-v1.5，环境设置已添加 huggingface.co，但当前运行实例仍报告旧网络配置（额外域名为空），模型下载返回403。下述测试中的确定性向量仅是传输与恢复夹具，不代表语义模型效果。

## 运行配置

默认 `INDEX_ENABLED=false`，未配置模型时保持 awaiting_indexer，不伪造就绪。启用后，受控恢复器只恢复已有分块、未取消、模型配置兼容的等待任务。成功完成 dense 写入与读回验证后，代际标记 ready，任务停在 awaiting_publication；不自动扫描通过、切换发布指针或向员工开放内容。

生产可配置独立 Milvus 服务；当前云端剩余磁盘不足以容纳完整 Standalone，实际开发验证采用 **Milvus Lite 2.4.12 + Node SDK 2.4.9**，仅验证稠密向量。Lite与Standalone的容量、持久化、认证、高可用及混合检索能力不等同；未声称Standalone或BM25已验收。新版SDK/Lite组合在本环境出现schema与加载状态兼容错误，当前组合经过真实创建、写入、读回、检索和重启验证，升级必须重跑相同套件。

```sh
python3 -m venv .venv-index
. .venv-index/bin/activate
pip install -r requirements-dev-index.txt
python scripts/models/milvus-lite.py --database /absolute/path/knowledge-index.db --address 127.0.0.1:19530
# 另一个终端：模型下载需要环境允许 Hugging Face 及实际重定向域名。
python scripts/models/download.py --directory .models/bge-small-zh --revision <40位上游commit-SHA>
python scripts/models/serve.py --directory .models/bge-small-zh --port 8081
curl http://127.0.0.1:8081/metadata
```

下载器只下载固定提交的 tokenizer 和量化 ONNX，不在运行时联网。manifest记录文件SHA与处理版本；启动服务再次核验文件。模型权重不提交仓库。把 `/metadata` 的 revision 填入 `.env` 的 EMBEDDING_REVISION，配置同一 model/dimension/processing，设置 INDEX_ENABLED=true，重启 API 和 Worker。示例采用本地512维 BGE；不允许用可变 main 充当版本号。

本地服务只监听回环地址、CPU推理、关闭请求正文日志，单次处理最多32条，忙时429。使用CLS表示，文本超过510个普通token时分窗，窗口向量先L2归一化、按token数加权平均后再归一化；不会静默截掉1200字符片段尾部。中文查询增加固定检索提示词，文档不加前缀。真实权重下的中文/术语/长输入行为仍需实测。

可在模型就绪后运行 `npm run validate:embedding -- --write`：用虚构差旅与产品型号样本做本地推理和真实Milvus检索，记录固定模型版本、维度、分数及超过512token的长输入。该命令只接受本地服务，清理自己创建的临时租户/代际记录，不删除共享collection。只有实际运行后才生成模型验收记录。

## 模型空间与代际

配置哈希包含 endpoint、model、revision、dimension、processing、文档/查询前缀、L2/float32规范与dense schema版本。API密钥、重试时长、批大小不进入模型空间。配置地址不含内嵌凭据、查询串或片段。远程嵌入默认拒绝，必须通过显式 EMBEDDING_ALLOW_REMOTE=true 与环境网络/凭据配置启用；本次用户选择本地，不向远程模型发送文档。

每种空间使用独立collection名，创建与使用前核对完整空间哈希和向量维度。响应必须匹配model、条数、唯一index、维度和有限非零数值；保存为L2归一化float32。查询适配层先核对期望空间，再使用同一固定查询策略；不能把其他模型或维度的查询向量塞入旧索引。

`index_generation`冻结租户、库/文档版本、解析/分块版本、分块产物摘要、模型空间、配置哈希、collection和 required_artifacts=['dense']。换模型/维度生成独立代际；显式重新校验创建新构建代际，历史ready代际保留。`index_receipt`按代际和块记录真实读回验证；dense_index检查点指向最近完成的generation及profile，旧代际凭其收据追踪。

Milvus仅保存向量和 tenant/kb/document/version/generation/chunk/model_space/retrieval_sha、policy_bucket_ids、active_hint等最小定位信息，不保存正文或凭据。active_hint始终false，等待后续发布流程。ACL字段只是优化提示，不授予访问权；P1-09仍须按PG中的当前权限和已发布二元组过滤、复核。当前没有对普通员工开放向量检索API。

## 缓存与调用账本

缓存键为 `tenant + 完整模型空间 + 完整检索文本SHA`，可在同租户、同空间的版本间复用，不能跨租户或混用模型。缓存仅存向量，不存请求正文，ready向量拒绝UPDATE。分布式领取在PG串行化，同一缓存项只有一个调用者；批内相同文本只发送一次。按代际收据恢复已完成批次，读回验证通过则跳过重复写入；派生向量丢失时从缓存恢复，不重新嵌入。

调用前持久记录 building、owner、request ID与120秒租约，向服务转发 Idempotency-Key；不能假设任意供应商支持计费幂等。成功后立即同事务保存向量、服务报告的token数及调用用量，再写Milvus。进程在响应与保存之间崩溃时无法证明供应商是否计费：过期building转unknown，停止自动重发，需维护者核对服务日志后恢复。不存在跨外部供应商与PG的“绝不重复计费”分布式事务保证。

429遵守Retry-After与PG重试预算；明确未建立连接的故障可退避重试；认证/请求拒绝给出可操作原因。超时、断流、5xx、错模型或无效成功响应视为结果不确定，缓存转unknown，不自动再次付费。Milvus故障使用PG预算重试，直接复用已保存向量；稳定主键upsert后读回逐条校验空间、摘要和实际向量，再提交收据。

取消、撤权、源拒绝、旧租约和截止时间会阻止ready提交。已返回的模型结果可以留在私有缓存以避免重复调用，但不能因此发布或绕过资源权限。Milvus写入与PG提交之间仍可能留下未引用/未就绪的派生记录；后续清理需按代际和PG引用回收，不能把active_hint当作唯一授权或删除依据。

## 接口与界面

- `GET /api/v1/documents/:doc/versions/:version/index-generations`：当前可见版本最近20个代际，不返回向量、地址、密钥或缓存内容。
- `POST`同一路径：当前write及任务所有者/显式库管理者授权，CSRF/Origin与Idempotency-Key；空对象按当前服务配置构建缺失代际，`{"reverify":true}`创建新的校验构建；不接受客户端指定模型、endpoint或脚本。取消任务不复活，同key不同参数409。
- 前端“索引详情”显示真实模型/版本/维度、已验证数量、缓存命中次数、服务报告token和代际历史，可显式重建。

## 成本与容量

默认每批16条（可配置1—32），单条检索正文最多1200 UTF-16字符，HTTP调用15秒，Milvus调用10秒；所有调用还受任务整体预算和租约约束。配置见 `.env.example`。token不由字符数伪造，服务未报告则为null。缓存命中次数是执行次数，重试时可大于片段数量；新增输入数记录成功向量化的唯一文本数。

供应商费用估算 = 实际报告token数 / 1,000,000 × 当时供应商报价；例如把单价记为P，10,000条每条平均T tokens、缓存命中率H，则新增嵌入费用约为 `10000×T×(1-H)/1000000×P`。P/T/H必须来自实际报价与用量，本次未填写虚构价格或企业平均token数。EMBEDDING_COST_PER_MILLION可保存运维报价，但不会被当作实际账单。CPU本地推理没有该外部API账单，仍有计算、内存、存储和运维成本。

纯float32向量下限为 `片段数×维度×4` 字节；512维下100万向量约2.048GB十进制，不包含PG缓存、索引结构、元数据、复制、历史代际和备份。Lite不构成生产容量验收。

## 验证与当前限制

`npm run check`包含适配契约测试；`INDEX_PYTHON=/path/to/python npm run test:indexing`使用独立PG schema、S3桶、Redis队列、Milvus Lite数据库及回环HTTP夹具。覆盖真实dense创建/写入/读回/查询、固定空间隔离、跨版本缓存、429等待、未知结果停止重发、模型/维度切换、幂等重建、Milvus重启后缓存恢复、权限/CSRF、撤权及执行中取消。确定性夹具不是模型效果测试。

当前待验收：运行实例应用新的网络设置、固定中文模型下载与CPU实际推理、中文近义词/专业术语/型号与长输入实测；完整Standalone、企业语料、BM25、生产容量/备份与授权检索另行验收。P1-08尚未标记整体完成，下一步先补本地模型验收，再进入P1-09。

### 本次接入代码验收

- 全工作区类型检查/构建与适配契约测试通过，基础2项、解析11项、分块9项、嵌入适配8项、身份12项、资源15项、上传17项、持久任务12项、解析链路8项、分块链路11项、索引链路13项，共118项自动化测试通过。
- 索引链路使用真实Milvus Lite与回环HTTP夹具；验证跨版本缓存、模型/维度隔离、429等待、SIGKILL后不重发不确定调用、Milvus停机/重启恢复、部分批次断点续作、固定配置/幂等重建、权限/撤权和取消。
- Playwright + 系统Chromium通过真实Milvus就绪状态、索引详情、模型/版本/维度、缓存重建与代际历史、390px移动布局；嵌入向量为夹具，未将其计入真实模型效果验收。
- 锁文件离线npm ci、Python脚本语法检查、迁移006实际应用、独立Worker真实队列往返与git diff检查通过。前端入口包仍有大小提示。CI接入相同索引套件，远程运行状态以实际Actions记录为准。
- 最终网络复查仍返回403，运行实例观测版本仍为1、额外允许域名为空。需在后续继续时选用已更新网络配置的运行环境，完成固定中文模型下载和实测；P1-08仍保留未完成标记。
