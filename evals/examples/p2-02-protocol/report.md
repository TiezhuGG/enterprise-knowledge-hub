# P2-02 混合召回对照

BM25 runs on the frozen fictional corpus; dense uses protocol vectors. Do not infer semantic quality or production gains.

状态：automatic-comparison-human-review-pending；数据集：70b23e4110fba0b2d658a9111c2c261ffc88cba8a4f32f28a7d471debe52a84c。

|类别|通道|Top1|Recall@5|MRR|应为空样本命中空结果|权限安全|错误|
|---|---|---|---|---|---|---|---|
|identifier|dense|0.14285714285714285 (n=7)|0.5 (n=7)|0.2357142857142857 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|lexical|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|hybrid_depth5|0.5714285714285714 (n=7)|1 (n=7)|0.7857142857142857 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|hybrid_depth20|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|hybrid|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|hybrid_depth80|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|hybrid_k10|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|abbreviation|dense|0 (n=3)|0.3333333333333333 (n=3)|0.16666666666666666 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|lexical|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|hybrid_depth5|0.3333333333333333 (n=3)|1 (n=3)|0.6666666666666666 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|hybrid_depth20|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|hybrid|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|hybrid_depth80|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|hybrid_k10|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|dense|0 (n=3)|0 (n=3)|0 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|lexical|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|hybrid_depth5|0 (n=3)|1 (n=3)|0.5 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|hybrid_depth20|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|hybrid|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|hybrid_depth80|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|hybrid_k10|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|phrase|dense|0 (n=2)|1 (n=2)|0.26666666666666666 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|lexical|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|hybrid_depth5|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|hybrid_depth20|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|hybrid|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|hybrid_depth80|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|hybrid_k10|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|negative|dense|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|lexical|未测 (n=0)|未测 (n=0)|未测 (n=0)|1 (n=2)|1 (n=2)|0|
|negative|hybrid_depth5|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|hybrid_depth20|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|hybrid|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|hybrid_depth80|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|hybrid_k10|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|permission|dense|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|lexical|未测 (n=0)|未测 (n=0)|未测 (n=0)|1 (n=4)|1 (n=4)|0|
|permission|hybrid_depth5|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|hybrid_depth20|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|hybrid|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|hybrid_depth80|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|hybrid_k10|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|

RRF各通道名次、贡献、原始分数、候选深度及主动注入的严格/降级观测见report.json。通道失败不作为正常空结果；降级必须明示。

逐题摘录、版本/代际/分块、排名和错误见 report.json。未执行不记为通过；相近型号、缩写和短语均为主动设计的挑战样本。
