# 知衡 · 企业知识中枢

Enterprise Knowledge Hub｜项目规划与界面设计基线｜2026-11-06

**P2-05 索引发布与安全重建代码已实现；真实模型基线和真人抽检仍待完成。** 现包含 React 前端、NestJS API、独立 BullMQ 开发 Worker、共享契约、配置与 CI；已支持 TXT、Markdown、文本型 PDF、DOCX 结构解析、分块与来源预览、任务恢复与取消；已提供Milvus稠密索引接入；已接入授权语义检索、BM25词法检索、可解释RRF融合、本地重排适配与证据预算；已接入本地生成服务的原文摘录问答；已支持持久聊天运行、有序SSE、历史恢复、停止与引用定位；已提供文档逻辑删除、可追踪的异步清理与历史保留期；企业 OIDC 与真实安全扫描器尚未接入。设计稿数据为虚构示例，仓库不含真实密钥。

开发启动、环境要求与验证命令见 [开发说明](docs/development.md)；登录配置与安全边界见 [身份说明](docs/p1-02-authentication.md)，知识库授权见 [资源与权限说明](docs/p1-03-resources-and-access.md)，上传及对象存储见 [上传与版本说明](docs/p1-04-uploads-and-versions.md)，任务运行见 [处理任务说明](docs/p1-05-ingestion-jobs.md)，格式与质量边界见 [解析说明](docs/p1-06-document-parsing.md)，分块规范见 [分块与溯源说明](docs/p1-07-chunking-and-provenance.md)，索引配置与验收范围见 [嵌入与索引说明](docs/p1-08-embedding-and-index.md)，授权门禁见 [检索说明](docs/p1-09-authorized-retrieval.md)，本地生成配置与回答边界见 [问答说明](docs/p1-10-grounded-answers.md)，聊天恢复与事件协议见 [流式问答说明](docs/p1-11-streaming-chat.md)，逐题评测与人工复核见 [评测说明](docs/p1-12-baseline-evaluation.md)，维护者恢复/修订与审计见 [人工纠错说明](docs/p1-13-knowledge-corrections.md)，删除时效、物理清理与保留配置见 [生命周期说明](docs/p1-14-deletion-and-retention.md)，词法通道、术语与对照范围见 [词法检索说明](docs/p2-01-lexical-retrieval.md)，融合、候选深度与降级见 [混合检索说明](docs/p2-02-hybrid-retrieval.md)，本地重排协议与证据预算见 [重排说明](docs/p2-03-reranking-and-context.md)，目录同步、签名证明与权限门禁见 [连接器说明](docs/p2-04-directory-connectors.md)，显式发布、影子核验、切换与安全回滚见 [索引发布说明](docs/p2-05-index-publication.md)。

```sh
cp .env.example .env
npm ci
npm run infra:up
npm run build:packages
npm run db:migrate
npm run db:seed:dev
npm run dev
```

## 从这里开始

1. 阅读 [项目总计划](docs/00-master-plan.md)，理解目标、范围与关键决策。
2. 阅读 [产品与业务体验](docs/01-product-and-experience.md)，明确角色和成功标准。
3. 阅读 [架构与技术选型](docs/02-architecture-and-stack.md)，对照原图理解新增治理链路。
4. 阅读 [业务、安全与质量](docs/03-business-security-and-quality.md)，理解怎样才算企业级。
5. 阅读 [数据与 API](docs/04-data-and-api.md)，把概念映射为资源、状态和契约。
6. 阅读 [任务与 Agent 学习路线](docs/05-roadmap-and-learning.md)，从 P0 首项按依赖推进。
7. 阅读 [界面规格](docs/06-ui-specification.md)，再打开 `design/ui-design-book.pdf` 查看32个主界面和补充状态设计。

设计材料可直接从文件管理器浏览，无需安装依赖；运行应用需按开发说明安装依赖。`design/screens/` 保存逐页 PNG，`design/ui-design-book.pdf` 是完整设计册，`design/contact-sheet.png` 是总览。设计按钮只是画面示意，不会调用后台。

## 目录

- `docs/`：七份完整中文设计文档，含 Mermaid 图、接口样例与任务清单。
- `design/`：UI 设计册、逐屏画面、总览和页面映射。
- `references/program.png`：用户提供的参考架构图。
- `references/sources.md`：官方参考资料、核查日期与适用边界。
- `PROJECT-STATUS.md`：交付状态、后续入口、尚待验证的假设。

## 使用方式

把这次成果当作 v0.1 设计基线。P0 业务验证仍待完成：选定一个业务部门，准备脱敏样本文档与真实问题，验证容量、权限和效果目标；以事实校准后续业务实现。不要把设计稿里的示例分数或估算工期当作系统实测能力。
