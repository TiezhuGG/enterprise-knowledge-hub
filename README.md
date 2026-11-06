# 知衡 · 企业知识中枢

Enterprise Knowledge Hub｜项目规划与界面设计基线｜2026-11-06

**本仓库当前只包含规划、产品/架构/API 设计、任务路线和 UI 设计稿；尚未编写或运行业务应用。** 所有界面数据为虚构演示数据。Git 仓库仅保存在本地，不含远程地址或真实密钥。

## 从这里开始

1. 阅读 [项目总计划](docs/00-master-plan.md)，理解目标、范围与关键决策。
2. 阅读 [产品与业务体验](docs/01-product-and-experience.md)，明确角色和成功标准。
3. 阅读 [架构与技术选型](docs/02-architecture-and-stack.md)，对照原图理解新增治理链路。
4. 阅读 [业务、安全与质量](docs/03-business-security-and-quality.md)，理解怎样才算企业级。
5. 阅读 [数据与 API](docs/04-data-and-api.md)，把概念映射为资源、状态和契约。
6. 阅读 [任务与 Agent 学习路线](docs/05-roadmap-and-learning.md)，从 P0 首项按依赖推进。
7. 阅读 [界面规格](docs/06-ui-specification.md)，再打开 `design/ui-design-book.pdf` 查看32个主界面和补充状态设计。

项目可直接从文件管理器浏览，无需安装依赖。`design/screens/` 保存逐页 PNG，`design/ui-design-book.pdf` 是完整设计册，`design/contact-sheet.png` 是总览。设计按钮只是画面示意，不会调用后台。

## 目录

- `docs/`：七份完整中文设计文档，含 Mermaid 图、接口样例与任务清单。
- `design/`：UI 设计册、逐屏画面、总览和页面映射。
- `references/program.png`：用户提供的参考架构图。
- `references/sources.md`：官方参考资料、核查日期与适用边界。
- `PROJECT-STATUS.md`：交付状态、后续入口、尚待验证的假设。

## 使用方式

把这次成果当作 v0.1 设计基线。下一步先做 P0 需求验证：选定一个业务部门，准备脱敏样本文档与真实问题，验证容量、权限和效果目标；得到事实后再开始实现。不要把设计稿里的示例分数或估算工期当作系统实测能力。
