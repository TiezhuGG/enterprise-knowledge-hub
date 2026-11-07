# P2-03 重排与上下文对照

Constant dense vectors and literal rerank fixtures: protocol only, not semantic quality or production latency.

状态：automatic-comparison-human-review-pending；数据集：292145f1078d00d8f06714db57cd81f108033541e43532adbbe7898e830fc4c4。

|类别|通道|Top1|Recall@5|MRR|应为空样本命中空结果|权限安全|错误|
|---|---|---|---|---|---|---|---|
|identifier|hybrid|0.8571428571428571 (n=7)|1 (n=7)|0.9285714285714286 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|rerank_n5|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|rerank_n15|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|rerank_n40|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|rerank_short64|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|abbreviation|hybrid|0.3333333333333333 (n=3)|1 (n=3)|0.6666666666666666 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|rerank_n5|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|rerank_n15|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|rerank_n40|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|rerank_short64|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|hybrid|0.6666666666666666 (n=3)|1 (n=3)|0.8333333333333334 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|rerank_n5|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|rerank_n15|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|rerank_n40|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|rerank_short64|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|phrase|hybrid|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|rerank_n5|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|rerank_n15|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|rerank_n40|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|rerank_short64|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|negative|hybrid|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|rerank_n5|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|rerank_n15|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|rerank_n40|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|rerank_short64|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|permission|hybrid|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|rerank_n5|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|rerank_n15|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|rerank_n40|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|rerank_short64|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|long_text|hybrid|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|long_text|rerank_n5|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|long_text|rerank_n15|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|long_text|rerank_n40|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|long_text|rerank_short64|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|

本次重排使用受控字面匹配协议服务，不能用于真实中文/长文本效果或延迟承诺。JSON记录top-N、裁剪、报告用量及回退原因；硬件费用未知，cost为null。

|类别|策略|重排阶段均值ms（含门禁/HTTP/校验）|输入字符均值|服务报告用量均值|费用|
|---|---|---|---|---|---|
|identifier|hybrid|0 (n=7)|0|未测|未知|
|identifier|rerank_n5|65.43795685714473 (n=7)|853.1428571428571|853.1428571428571|未知|
|identifier|rerank_n15|70.8088621428594 (n=7)|2497.714285714286|2497.714285714286|未知|
|identifier|rerank_n40|78.73477857143007 (n=7)|3897.8571428571427|3897.8571428571427|未知|
|identifier|rerank_short64|62.187580999999874 (n=7)|526.7142857142857|526.7142857142857|未知|
|abbreviation|hybrid|0 (n=3)|0|未测|未知|
|abbreviation|rerank_n5|48.328565333333245 (n=3)|849|849|未知|
|abbreviation|rerank_n15|58.508050666668474 (n=3)|2487.6666666666665|2487.6666666666665|未知|
|abbreviation|rerank_n40|60.27329866666454 (n=3)|3886.6666666666665|3886.6666666666665|未知|
|abbreviation|rerank_short64|52.387446666666314 (n=3)|516.6666666666666|516.6666666666666|未知|
|chinese_term|hybrid|0 (n=3)|0|未测|未知|
|chinese_term|rerank_n5|48.74693999999969 (n=3)|841.3333333333334|841.3333333333334|未知|
|chinese_term|rerank_n15|50.33662799999971 (n=3)|2491.6666666666665|2491.6666666666665|未知|
|chinese_term|rerank_n40|59.12417833333408 (n=3)|3891.6666666666665|3891.6666666666665|未知|
|chinese_term|rerank_short64|58.63999733333427 (n=3)|520.6666666666666|520.6666666666666|未知|
|phrase|hybrid|0 (n=2)|0|未测|未知|
|phrase|rerank_n5|52.70314249999865 (n=2)|843|843|未知|
|phrase|rerank_n15|58.649585000002844 (n=2)|2503|2503|未知|
|phrase|rerank_n40|71.4010285000004 (n=2)|3904|3904|未知|
|phrase|rerank_short64|54.09372649999932 (n=2)|532|532|未知|
|negative|hybrid|0 (n=2)|0|未测|未知|
|negative|rerank_n5|59.513254500001494 (n=2)|843|843|未知|
|negative|rerank_n15|60.442682500000956 (n=2)|2503|2503|未知|
|negative|rerank_n40|65.8472490000022 (n=2)|3904|3904|未知|
|negative|rerank_short64|54.13417600000321 (n=2)|532|532|未知|
|permission|hybrid|0 (n=4)|0|未测|未知|
|permission|rerank_n5|56.58350349999637 (n=4)|843|843|未知|
|permission|rerank_n15|57.251206250000905 (n=4)|2503|2503|未知|
|permission|rerank_n40|64.10035425000024 (n=4)|3904|3904|未知|
|permission|rerank_short64|56.49031224999999 (n=4)|532|532|未知|
|long_text|hybrid|0 (n=2)|0|未测|未知|
|long_text|rerank_n5|54.94938249999541 (n=2)|843|843|未知|
|long_text|rerank_n15|51.767158999995445 (n=2)|2503|2503|未知|
|long_text|rerank_n40|61.60365599999932 (n=2)|3904|3904|未知|
|long_text|rerank_short64|60.827638499991735 (n=2)|532|532|未知|

协议服务的报告用量是字符计数，不是真实模型token数；耗时仅为本次运行观测。

RRF各通道名次、贡献、原始分数、候选深度及主动注入的严格/降级观测见report.json。通道失败不作为正常空结果；降级必须明示。

逐题摘录、版本/代际/分块、排名和错误见 report.json。未执行不记为通过；相近型号、缩写和短语均为主动设计的挑战样本。
