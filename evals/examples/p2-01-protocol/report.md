# P2-01 检索对照

BM25 runs on the frozen fictional corpus; dense uses protocol vectors. Do not infer semantic quality or production gains.

状态：automatic-comparison-human-review-pending；数据集：70b23e4110fba0b2d658a9111c2c261ffc88cba8a4f32f28a7d471debe52a84c。

|类别|通道|Top1|Recall@5|MRR|应为空样本命中空结果|权限安全|错误|
|---|---|---|---|---|---|---|---|
|identifier|dense|0 (n=7)|0.42857142857142855 (n=7)|0.09999999999999999 (n=7)|未测 (n=0)|1 (n=7)|0|
|identifier|lexical|1 (n=7)|1 (n=7)|1 (n=7)|未测 (n=0)|1 (n=7)|0|
|abbreviation|dense|0 (n=3)|0.3333333333333333 (n=3)|0.1111111111111111 (n=3)|未测 (n=0)|1 (n=3)|0|
|abbreviation|lexical|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|dense|0.6666666666666666 (n=3)|0.6666666666666666 (n=3)|0.6666666666666666 (n=3)|未测 (n=0)|1 (n=3)|0|
|chinese_term|lexical|1 (n=3)|1 (n=3)|1 (n=3)|未测 (n=0)|1 (n=3)|0|
|phrase|dense|0 (n=2)|1 (n=2)|0.375 (n=2)|未测 (n=0)|1 (n=2)|0|
|phrase|lexical|1 (n=2)|1 (n=2)|1 (n=2)|未测 (n=0)|1 (n=2)|0|
|negative|dense|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=2)|1 (n=2)|0|
|negative|lexical|未测 (n=0)|未测 (n=0)|未测 (n=0)|1 (n=2)|1 (n=2)|0|
|permission|dense|未测 (n=0)|未测 (n=0)|未测 (n=0)|0 (n=4)|1 (n=4)|0|
|permission|lexical|未测 (n=0)|未测 (n=0)|未测 (n=0)|1 (n=4)|1 (n=4)|0|

逐题摘录、版本/代际/分块、排名和错误见 report.json。未执行不记为通过；相近型号、缩写和短语均为主动设计的挑战样本。
