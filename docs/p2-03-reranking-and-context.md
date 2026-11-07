# P2-03 重排模型与上下文选择

日期：2026-11-08（上海时间）。新增本地重排适配层、top-N/输入长度限制、最终文档配额及可追踪回退。默认不启用重排，无新增依赖或数据库迁移。预留候选模型名为bge-reranker-v2-m3；当前未部署真实服务，权重版本、中文/长文本表现和本机资源需求尚未验收，不自动下载模型。协议夹具不能替代真实模型质量与真人抽检。

## 使用与参数

```dotenv
RERANK_ENABLED=false
RERANK_BASE_URL=http://127.0.0.1:8083/v1
RERANK_MODEL=bge-reranker-v2-m3
RERANK_REVISION=
RERANK_TIMEOUT_MS=2000
# 需要认证时使用RERANK_API_KEY环境变量，不将密钥放入请求体或聊天。
```

RERANK_ENABLED=true要求完整的模型名、固定revision和loopback服务地址；只允许localhost/127.0.0.1/::1，不允许远程地址、URL凭证、查询参数或重定向。模型配置在服务端，客户端不能指定模型或地址。请求级开关也必须启用，配置服务不会自动改变既有dense、lexical或hybrid基线。

```json
{
  "query": "A-100 的安装规范是什么？",
  "mode": "hybrid",
  "hybrid": {"candidate_depth": 20},
  "rerank": {
    "enabled": true,
    "top_n": 15,
    "max_input_characters": 1000,
    "failure_policy": "fusion"
  },
  "context": {"max_per_document": 2},
  "top_k": 5,
  "max_characters": 6000
}
```

用于POST /search、/answers以及/chat-runs（聊天使用message代替query）。rerank只允许hybrid模式。搜索页提供“启用本地重排”开关，使用15条/1000字符/每文档2条的可见预算策略；问答页仍保持原默认通道，调用方可通过API显式使用重排。

|参数|默认|边界|
|---|---|---|
|rerank.enabled|false|布尔值|
|rerank.top_n|15|1—40，截取RRF排名最前的N个候选|
|rerank.max_input_characters|1000|64—1600个Unicode码点，每条输入单独截断|
|rerank.failure_policy|fusion|fusion或fail|
|context.max_per_document|20|1—20，对最终证据按文档计数；UI重排方案设为2|
|top_k / max_characters|5 / 6000|保持原有1—20条、500—16000上下文字符预算|

示例中每通道最多20个唯一候选，融合后最多40条；仅前15条进入重排，最终在去重、文档配额和字符预算内取最多5条。实际数量记录在received_candidates、sent_candidates和selection，不能把设置上限当作实际调用数量。

## 本地服务协议

适配层向base URL的`/rerank`发送一次JSON请求：model、revision、query、documents字符串数组、top_n=实际数组长度、return_documents=false。它是独立的重排接口，不是/embeddings或/chat/completions。可用轻量本地包装服务对接选定模型。

响应示例：

```json
{
  "model": "bge-reranker-v2-m3",
  "revision": "固定权重版本",
  "results": [
    {"index": 1, "relevance_score": 2.4},
    {"index": 0, "relevance_score": -0.3}
  ],
  "usage": {"total_tokens": 128}
}
```

model和revision必须匹配请求，index必须完整、唯一且在本批候选范围内，score必须有限。响应只能改变顺序；服务返回的文档、引文或其他文本全部忽略，不能作为证据。按score降序，同分保留原RRF顺序。分数可能是logit，不作概率或可回答性阈值。

输入最多40×1600码点，响应体最多256KiB；超时可配置100—10000ms，不自动重试。进程内最多2个重排阶段、每成员最多1个；这不是集群全局配额。超时或断开不证明后端推理已经停止，用量未知时不填0或自动补发调用。

## 授权与生命周期

1. dense/lexical召回、RRF融合及原有版本/哈希/收据门禁先完成。
2. 取RRF前N条，在派发事务中重新授权初始范围的全部目标，并核对本批收据；只将已授权、已校验候选的retrieval_text发送到本地服务，不发送对象key或引用凭证。
3. 启动HTTP请求后释放PG事务，推理期间不长期持有权限锁。删除或撤权可以提交。
4. 结果或回退返回后，再次校验整个原始范围及本批收据，才组装最终证据。权限、发布状态、收据变化和调用方取消直接拒绝，不能降级成成功结果。

截断只用于重排输入，按Unicode码点切分，不拆代理对。最终snippet、原文版本、来源位置与签名引用保持原样；模型没看到尾部可能影响相关性，truncated标记会保留。没有新增持久化正文副本，P1-14的逻辑失效、物理清理和历史保留仍适用。

## 回退与最终上下文

默认failure_policy=fusion：服务未配置、忙、超时、不可用、模型/版本不匹配或响应不合法时，忽略模型输出，回到原RRF顺序，并记录meta.rerank.status=fallback、reason和meta.degraded=true。配置错误不发送请求。fail策略则返回503，适用于质量评测等不能混入回退结果的场景。

成功重排后仅从已评分的N条中选择证据，不把未评分尾部与模型分数混排。最终仍按内容哈希去重，满足每文档配额和原有序列化上下文预算；放不下的证据整条跳过，不切断原文拼成引用。selection记录实际扫描数、选取数、去重数、预算及文档配额跳过数。

无候选时不调用模型，status=skipped。成功时证据另有rerank.rank/score/original_rank/truncated，原score仍是RRF分数，不混加。搜索显示处理状态，hybrid问答和历史聊天保留回退元数据及警告。模型不可用与正常无答案分开；最终无证据的降级问答仍按retrieval_incomplete处理。

## 分组对照

[冻结数据集](../evals/rerank-v1/dataset.json)及[锁文件](../evals/rerank-v1/dataset.lock.json)从P2-01派生，包含18份虚构文档、23题。新增尾部证据长文本，以及足够生成40个以上候选的预算演练语料；不能仅因为语料过少让N=15和N=40成为相同调用后宣称已验证大批量重排。

```sh
npm run check
INDEX_PYTHON=/path/to/python npm run test:reranking
INDEX_PYTHON=/path/to/python npm run compare:retrieval -- --fixture --rerank --output work/new-rerank-protocol
INDEX_PYTHON=/path/to/python npm run compare:retrieval -- --rerank --output work/new-real-rerank
```

同一语料、授权范围、RRF深度40/k=60、top_k=5、每文档2条和相同字符预算下，对照RRF基线、N=5/15/40、N=15但输入64码点五个策略，共115次检索。质量运行使用failure_policy=fail，避免把融合回退计为模型效果。另注入服务错误和反向排名，分别检查回退和明确退化；注入不是实际模型的自然失败。

[协议观测](../evals/examples/p2-03-protocol/report.md)及JSON记录各类Top1、参考文档Recall@5、MRR、实际top-N、截断数、阶段耗时、输入量及服务报告用量。阶段耗时包含派发门禁/HTTP/校验；夹具用量是字符计数，不是真实token，不能用于真实模型性能承诺。没有本地硬件费用数据，cost始终保留null，不能当作免费。

[真实运行阻塞记录](../evals/examples/p2-03-blocked/report.md)明确保留未部署状态，未运行不计为通过。真实服务上线后应固定权重、分组测量中文/长文本收益与退化、延迟和费用，再由真人复核，决定是否启用。当前保持默认关闭。

## 回归覆盖

专项覆盖本地地址/版本绑定、输入和响应边界、唯一索引映射、同分稳定、无自动重试、Unicode截断、只发送可见来源、推理中撤权/发布/收据变化、超时、取消、并发回退、文档配额与完整引用、聊天历史警告。浏览器验证开关、重排分数/原名次、来源复核、明确回退、旧证据清除及390px布局。原有全链路继续回归，无新增迁移。

本次验证：90项基础/单元测试、212项集成测试通过，合计302项；桌面与390px浏览器无页面异常。115次协议检索中实际提交数量达到40，两个受控检查通过；反向排名注入使首题参考MRR从1降至0，这是主动制造的退化，不是真实模型结论。真实模型阻塞记录保留0个已执行质量样本，重排仍默认关闭。
