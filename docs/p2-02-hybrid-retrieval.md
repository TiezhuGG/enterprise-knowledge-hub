# P2-02 混合召回、RRF 与去重

日期：2026-11-08（上海时间）。新增并行dense/lexical候选、可解释的Reciprocal Rank Fusion（RRF）及显式单通道降级。默认继续dense；选择hybrid才融合，且默认要求两个通道完成。没有增加模型、依赖、数据库迁移或持久化索引。真实模型质量比较仍待本地模型部署与人工相关性复核。

## 数据流和门禁

1. 认证后取得同一个可读、clean、确切发布版本/代际且ready的初始目标集合；hybrid受词法基线的50文档/5000分块/32MiB/50万词项上限约束。
2. 同时启动dense查询嵌入/Milvus召回与lexical BM25候选。词法通道持有来源锁计算授权范围内的DF；两个通道都核对S3制品、分块身份与收据，不先返回top_k证据再做融合。
3. 各通道先按确切文档/版本/代际/分块身份去重，再截取candidate_depth个候选。RRF只使用每个通道的名次。
4. 两个通道结束后，在PG事务中重新检查初始集合的**全部目标**。即使变更的资料未进入最终top_k，也不能继续使用其旧统计或排名；撤权、发布切换、扫描/代际状态变化将拒绝本次结果，不转为降级。
5. 持有来源锁完成融合和证据组装，再按既有检索内容哈希去重与字符预算选取证据。运行中不扩大初始范围，下一请求会看到新增授权/发布资料。

融合身份为`document_id/version_id/generation_id/chunk_id`：同一命中跨通道只输出一个候选；不同版本或不同文档不能因为文字相同而合并排名贡献。最终上下文仍可按内容SHA去掉重复段落，但保留的是某一确切来源，并不把不同来源的贡献累加到一起。引用复核、历史读取、SSE与删除/撤权门禁继续使用原有路径。

## RRF的计算与解释

默认k=60，每条候选的融合分数为其出现通道的`1/(k+rank)`之和，rank从1开始。余弦分数与BM25仅用于各自通道排名/阈值，不直接相加。重复命中在同通道只计一次，名次按唯一候选连续编号；融合分数相同时按完整身份键稳定排序。

手算示例：dense为A、B、C、D、E；lexical为C、A、F、B、G。

|候选|dense名次|lexical名次|RRF分数|
|---|---:|---:|---|
|A|1|2|1/61 + 1/62|
|C|3|1|1/63 + 1/61|
|B|2|4|1/62 + 1/64|
|F|无|3|1/63|
|D|4|无|1/64|
|E|5|无|1/65|
|G|无|5|1/65|

结果A、C、B、F、D、E、G与单元测试一致。每条返回证据的`retrieval`记录algorithm、k、通道ranks、contributions和原始scores；`score`为RRF分数。页面展示名次与贡献。RRF不运行交叉编码器，不重新判断原文是否相关，也不生成置信概率。

## API与开关

```json
{
  "query": "A-100 安装",
  "mode": "hybrid",
  "top_k": 5,
  "max_characters": 6000,
  "hybrid": {
    "candidate_depth": 40,
    "rrf_k": 60,
    "allow_partial": false,
    "dense_min_score": 0.25,
    "lexical_min_score": 0
  }
}
```

适用于`POST /search`、`POST /answers`和`POST /chat-runs`（聊天使用message代替query）。只在mode=hybrid时允许hybrid对象，未知字段拒绝。hybrid不接受顶层min_score，避免把不同分数混成一个阈值。

|参数|默认|范围|
|---|---:|---|
|candidate_depth|40|每通道1—80个唯一候选，最多160个融合候选|
|rrf_k|60|整数1—200|
|allow_partial|false|布尔值；必须显式开启|
|dense_min_score|0.25|[-1,1]|
|lexical_min_score|0|[0,1000000]，只保留正BM25分数|

搜索页的通道选择可切回dense/lexical作为单通道基线。选择混合后可勾选“允许单通道降级（会标明原因）”。参数深度及k实验通过API/对照器进行；默认问答页面仍保持dense。

## 通道失败与降级

- 两个通道完成：degraded=false；一个通道正常返回0个候选也属于完成，另一个可以正常贡献排名。
- 一个已知运行依赖失败：默认503 `HYBRID_CHANNEL_UNAVAILABLE`。显式allow_partial=true时，才允许另一通道的已验证候选；meta.degraded=true，并保留各通道status、候选数和失败error_code。
- 两个通道均失败：503 `HYBRID_CHANNELS_UNAVAILABLE`，没有成功结果。
- 认证、授权、输入、范围上限、取消、收据/哈希/模式等完整性问题不允许降级。只有白名单中的查询模型/Milvus/对象存储依赖错误可使用另一通道；未知503不自动视为可恢复。
- 降级时没有证据：搜索明确带降级标记返回空结果；问答返回failed/retrieval_incomplete，不把依赖失败当作正常的“资料中没有答案”。

检索元数据会进入hybrid问答结果和持久聊天。历史回答显示降级警告，引用与SSE仍逐次重新授权。一次请求内不自动重试模型，也不会静默切换为另一个基线。单通道完成代表只完成了该通道，不能冒充完整混合检索。

## 对照实验与验证

继续使用P2-01同一份冻结的16文档/21题[数据集](../evals/lexical-v1/dataset.json)。成员、KB范围、发布版本、top_k=5、字符预算一致，协议实验的dense阈值统一为-1，lexical为0；对照7个策略：dense、lexical、hybrid深度5/20/40/80及深度40的k=10。默认hybrid的k=60。共147次检索，另显式注入两次查询嵌入故障，对照严格拒绝与开启降级。

```sh
npm run check
INDEX_PYTHON=/path/to/python npm run test:hybrid
INDEX_PYTHON=/path/to/python npm run compare:retrieval -- --fixture --hybrid --output work/new-hybrid-protocol
INDEX_PYTHON=/path/to/python npm run compare:retrieval -- --hybrid --output work/new-real-hybrid
```

[协议报告](../evals/examples/p2-02-protocol/report.md)及JSON保留每个策略的逐题来源、名次/贡献、Top1、参考文档Recall@5、MRR、错误与权限检查。受控故障的passed属于协议行为检查，独立于语义指标。正常未命中与通道失败分开；未执行和基础设施错误不记为通过。

本报告dense使用常量协议向量，排名存在按身份键打破的并列。因此候选深度造成的Top1差异只能说明候选截断和融合逻辑的作用，不能证明真实语义效果提升。默认hybrid不会把词法未命中当作全局禁止条件；当dense仍召回无关资料时，负例依然可能出现候选，RRF不能替代相关性评测或重排。[真实运行阻塞记录](../evals/examples/p2-02-blocked/report.md)保留模型未配置状态；真实质量与人工抽检未被替代。

专项测试包含手算RRF、原始分数尺度不影响融合、稳定并列、同通道重复命中、不同版本不合并、并行启动、参数边界、两个方向的降级、双失败、收据错误、隐藏资料排除、融合前撤权/发布变化、删除、问答及历史降级标记。桌面/390px浏览器验证完整融合解释、来源核验、严格失败、显式降级、清除旧证据和警告展示。其余已有功能继续跑全链路回归。

本次验证：82项基础/单元测试、199项集成测试全部通过，合计281项；共享检索、聊天、评测与hybrid另复跑53项门禁回归。桌面和390px浏览器无页面异常。21题×7策略的147次检索及2个受控故障检查均已归档；真实模型阻塞报告保留0个已执行质量样本。
