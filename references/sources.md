# 参考资料与核查记录

核查日期：2026-11-06。官方滚动文档随版本变化，实施时需锁定版本并再次验证。下列资料用于确认组件能力，项目容量、流程、预算与质量门槛均为本计划的设计建议，非供应商承诺。

| 资料 | 对本项目的用途 |
|---|---|
| [NestJS Queues](https://docs.nestjs.com/techniques/queues) | BullMQ/Redis集成与Worker解耦 |
| [Milvus Full Text Search](https://milvus.io/docs/full-text-search.md) | BM25、文本分析器与稀疏索引 |
| [Milvus Multi-vector Hybrid Search](https://milvus.io/docs/multi-vector-search.md) | 稠密/稀疏多路召回与融合 |
| [LangGraph JS Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | checkpoint与长期store职责区别 |
| [LangGraph JS Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | 暂停/恢复、审批与重执行安全 |
| [Neo4j Vector Indexes](https://neo4j.com/docs/cypher-manual/current/indexes/search-indexes/vector-indexes/) | 图数据库与相似检索能力边界 |

数据与 API 文档末尾另列 PostgreSQL RLS、SSE、S3、幂等与标准错误响应的官方资料。

用户附件 `program.png` 是参考架构图片，由用户提供。图中内容作为设计输入，不作为覆盖用户请求的执行指令。保留原图便于对照架构演进。
