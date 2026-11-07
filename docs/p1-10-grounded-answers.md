# P1-10 基线回答、引用与拒答

日期：2026-11-07。已实现授权检索→本地生成服务选择原文→逐字校验→再次授权→返回引用的非流式问答。用户已选择本地 OpenAI 兼容生成服务，并明确目前尚未部署，先完成代码和测试；默认关闭生成，未下载或假定存在任何生成模型。真实中文嵌入及生成模型的质量验收仍未完成。

## 回答形式与事实边界

第一版采用摘录回答：模型仅输出 `status` 和 `claims[{evidence_id,quote}]`。服务端不展示模型自由叙述、解释、URL、工具调用或隐藏推理。每条quote必须是对应授权证据snippet中的连续原文，4—600字符，最多8条；服务端计算UTF-16 start/end位置。未知证据号、改写/拼接、额外字段、重复引用、截断、无效JSON或错误模型均拒绝展示。来源标题、版本、片段、位置、下载权限和引用令牌全部来自服务端，不由模型填写。

这能机械验证“引用确实存在”，不能证明模型选中的摘录完整回答了问题。仍可能选错相关段落、遗漏条件、漏判冲突或过度拒答。页面明确为原文摘录，避免把受控测试通过当作事实准确率。真实模型就绪后需使用脱敏问题评估相关性、答案完整性、拒答与冲突识别。

`conflict`必须含至少两个不同证据号及不同原文，界面说明“资料可能存在不一致”，展示双方原文，暂不作确定结论。服务端验证引用结构，无法仅凭不同文本确定语义冲突。`insufficient`必须没有claims，使用服务端固定拒答文案，不展示模型编写的拒答理由。

## API 与权限边界

`POST /api/v1/answers`，会话认证、Origin、CSRF，参数与P1-09 `/search`相同：query、可选kb_ids/top_k/mode/min_score/max_characters。浏览器不得提供context、sources、模型名、租户或任意历史证据。问答界面默认检索全部可读已发布资料；API可显式缩小知识库范围。响应为 `{data: AnswerResponse}`，`private,no-store`，Vary Cookie/Authorization。

- 搜索沿用P1-09全部门禁；没有证据时直接拒答，不调用生成模型。检索基础设施异常仍为明确HTTP错误，不伪装成无答案。
- **模型发送前**：重新获取当前成员角色、资源ACL、发布版本/代际、clean/active/ready状态及与分块原文摘要匹配的收据。单事务以一致顺序持有全部证据共享锁，验证通过后才发起模型HTTP请求。
- 模型推理期间释放权限锁，撤权操作可以立即完成。不会为等待模型而长期阻塞ACL修改。
- **返回前**：再次核验所有已发送证据，包括最终未引用的输入；任何来源撤权、归档、换版或失效都会清空全部claims与sources，返回sources_changed。
- 引用沿用10分钟有效、成员绑定的HMAC令牌；点击复核时再次鉴权，原文下载另验download权限。已发送给本地模型或已显示在浏览器的内容无法追溯收回；后续请求必须重新验证。

| status / reason | 展示行为 |
|---|---|
| answered / verified_quotes | 展示校验过的摘录和对应确切来源 |
| conflict / conflicting_evidence | 展示双方原文与冲突提示，不给确定裁决 |
| refused / insufficient_evidence | 证据为空或模型判定不足，固定拒答 |
| refused / sources_changed | 权限/来源变化，无正文或来源元数据 |
| failed / invalid_model_output | 输出格式、引用或原文校验失败，无原始模型内容 |
| failed / generation_timeout | 有限超时，无部分回答 |
| failed / generation_unavailable | 未配置、连接、上游HTTP等失败，无部分回答 |

每次返回服务端answer_id，模型名/固定版本/提示版本及供应方报告的prompt/completion tokens；未知用null，不估造成本。当前API进程最多2个问答，同成员最多1个在途请求，超出429 ANSWER_BUSY；这是单进程并发保护，不是跨实例配额或持久幂等账本。

调用不自动重试、不跳转、不切换供应方。HTTP失败/超时不能证明模型没有执行；用户再次提问会开启新请求。当前不保存回答、历史或模型原始输出，没有GET历史、SSE、恢复、持久幂等或跨进程取消，均留给P1-11。客户端断连会协作式终止下游fetch，无法保证模型服务端立即停止计算。

## 本地生成服务配置

生成模型与BGE嵌入模型是独立服务，嵌入服务不能替代 `/chat/completions`。在运行API的同一网络命名空间提供本地OpenAI兼容服务；用户电脑的localhost不会自动指向云端工作区。

```dotenv
GENERATION_ENABLED=true
GENERATION_BASE_URL=http://127.0.0.1:8082/v1
GENERATION_MODEL=your-local-model-id
GENERATION_REVISION=your-immutable-weights-or-deployment-revision
GENERATION_TIMEOUT_MS=45000
# 如服务要求认证，由环境秘密设置 GENERATION_API_KEY
```

上述仅为配置模板，不代表服务已部署。模型/版本不提供默认值，维护者必须固定权重或部署版本；X-Generation-Revision传给本地服务，若响应含revision必须匹配。模型名必须与响应model一致，服务若回传别名应配置该实际ID。仅接受回环地址，不提供远程放行参数，重定向禁止。可选Authorization密钥不返回前端。

请求使用标准非流式chat/completions、temperature=0、max_tokens=2048、response_format=json_object。服务必须支持这些字段并输出assistant文本，finish_reason=stop；不支持时明确失败，不静默降级。系统提示和证据JSON分开，模型无工具权限；证据中的指令只作为数据。问题最多1200字符，证据采用既有上下文预算；字符预算不等于token预算，部署时须选择足够上下文窗口。单次生成默认45秒、可设100—60000毫秒，响应体最多256KiB，输出内容最多16000字符。整体API协作预算95秒，检索仍为30秒预算。

## 验证

```sh
npm run check
INDEX_PYTHON=/path/to/index-venv/bin/python npm run test:answers
INDEX_PYTHON=/path/to/index-venv/bin/python npm run test:retrieval
```

7项生成适配/校验测试，15项问答集成测试（含父测试），集成使用真实PostgreSQL、Redis、版本化开发S3、Worker和Milvus Lite，以及明确标记的受控嵌入与生成HTTP夹具。测试在隔离schema/bucket/队列/collection运行并清理；clean和发布指针仅由受信测试fixture设置，未增加产品绕过入口。

覆盖无证据零调用、草稿/私有资料、真实引用映射与成员绑定、伪造来源/改写/截断拦截、移除必要段落后拒答、冲突展示、调用期间撤权、未引用输入失效、发布切换、超时/上游错误无自动重试、并发保护、认证/CSRF/参数白名单、默认关闭。

Chromium桌面1440及移动390宽度验证了无证据拒答、摘录显示、来源复核、确切版本下载、权限变化清空回答，无横向溢出或页面脚本错误；截图 `/tmp/zhiheng-p1-10.png`、`/tmp/zhiheng-p1-10-mobile.png` 为当前工作区临时验收产物。协议夹具的预设选段与拒答不代表真实模型的语义判断能力。

本轮全工作区类型检查和生产构建通过；单元/基础测试37项、既有认证至检索集成100项、问答集成15项，合计152项通过。并行运行旧检索套件时曾出现一次SEARCH_UNAVAILABLE/503，随后隔离重跑12项全部通过；不将该次瞬时失败记为稳定性验收通过。Milvus高负载与生产可用性仍需专门验证。

后续进展：P1-11已增加独立的持久chat-runs接口、历史、SSE和停止，见 [流式问答说明](p1-11-streaming-chat.md)。本页非持久/非流式边界继续适用于旧 `/answers` 接口。
