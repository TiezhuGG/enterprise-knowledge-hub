import {writeFile} from 'node:fs/promises';
import {buildChunks} from '@zhiheng/chunker';
import {fixture,policySample,digest} from './chunk-fixtures.mjs';
const text=policySample(),{parsed,scope}=await fixture(text);
const questions=[
 {question:'城市010的住宿上限是多少？',terms:['城市010','住宿上限'],evidence:['城市010','309元','住宿上限']},
 {question:'城市075的住宿上限是多少？',terms:['城市075','住宿上限'],evidence:['城市075','374元','住宿上限']},
 {question:'城市099的餐补上限是多少？',terms:['城市099','餐补上限'],evidence:['城市099','148元','餐补上限']},
 {question:'提交哪些材料，超标住宿还需谁提前审批？',terms:['发票','审批单','超标住宿','主管'],evidence:['发票','出差审批单','部门主管','提前书面审批']},
 {question:'原始凭证在哪里保存，保存多久？',terms:['原始凭证','保存'],evidence:['原始凭证','财务系统','五年']}
];
const runs=[];
for(const strategy of ['fixed-window-v1','structure-v1']){
 const result=await buildChunks(parsed,scope,strategy),answers=questions.map(q=>{
  const ranked=result.chunks.map(chunk=>({chunk,score:q.terms.filter(t=>chunk.retrieval_text.includes(t)).length})).sort((a,b)=>b.score-a.score||a.chunk.ordinal-b.chunk.ordinal),top=ranked[0].chunk;
  return {question:q.question,ordinal:top.ordinal+1,complete:q.evidence.every(term=>top.retrieval_text.includes(term)),missing:q.evidence.filter(term=>!top.retrieval_text.includes(term))};
 });runs.push({strategy,result,answers});
}
const rows=runs.map(r=>`| ${r.strategy} | ${r.result.chunks.length} | ${r.result.metrics.retrieval_characters} | ${r.result.metrics.overlap_characters} | ${r.result.metrics.repeated_table_header_characters} | ${(r.result.metrics.duplicate_ratio*100).toFixed(1)}% | ${r.answers.filter(a=>a.complete).length}/5 |`).join('\n');
const details=questions.map((q,i)=>`| ${q.question} | ${runs.map(r=>{const a=r.answers[i];return `片段${a.ordinal}：${a.complete?'包含全部所需证据':`缺少 ${a.missing.join('、')}`}`}).join(' | ')} |`).join('\n');
const report=`# P1-07 分块策略样本对比\n\n日期：2026-11-07。运行 \`npm run compare:chunks -- --write\` 可重建本记录。样本为仓库自造的100行差旅标准表、审批流程和归档规则，不包含企业资料。\n\n样本文本 SHA-256：\`${digest(text)}\`。两种策略都限制检索文本最多1200 UTF-16字符，重叠参数120字符。固定窗口把解析正文串联后等长切片；结构策略保留章节边界，长段落按句子/空白边界切分，表格按完整行分组并重复表头。\n\n| 策略 | 片段数 | 检索字符总量 | 正文重叠字符 | 重复表头字符 | 精确重复片段比 | Top-1证据完整样本 |\n|---|---:|---:|---:|---:|---:|---:|\n${rows}\n\n| 样本问题 | 固定窗口 | 结构分块 |\n|---|---|---|\n${details}\n\n此处按给定问题关键词的出现数排序，平分时取原文靠前片段；“完整”仅表示同一片段含全部预先列出的证据词。这是可复现的词面检索与上下文完整性对照，不能当作向量检索召回率、模型问答正确率或生产效果评估。没有调用嵌入模型或大模型。\n\n结构策略付出更多片段与重复表头的成本，换取中后段表格行仍携带列含义。固定窗口更紧凑，但其后续窗口可能缺失表头，跨章节窗口也可能混入无关规则。首版采用 structure-v1；不做基于词面哈希的跨版本/跨权限去重，重复内容保留各自来源。下一阶段仍需用脱敏业务问题验证向量检索效果和分块成本。\n`;
if(process.argv.includes('--write'))await writeFile(new URL('../docs/p1-07-strategy-comparison.md',import.meta.url),report);else process.stdout.write(report);
