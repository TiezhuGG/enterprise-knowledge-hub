import {parseIsolated} from '@zhiheng/parser';
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function fixture(text,mime='text/markdown'){
 const parsed=await parseIsolated(Buffer.from(text),mime);parsed.blocks=parsed.blocks.map(b=>({...b,id:`10000000-0000-8000-a000-${String(b.ordinal).padStart(12,'0')}`}));
 return {parsed,scope:{tenant_id:'20000000-0000-4000-8000-000000000001',kb_id:'40000000-0000-4000-8000-000000000001',document_id:'50000000-0000-4000-8000-000000000001',version_id:'60000000-0000-4000-8000-000000000001',version_no:1,source_asset_id:'70000000-0000-4000-8000-000000000001',source_sha256:parsed.source_sha256,parser_version:parsed.parser_version,parsed_artifact_sha256:digest(JSON.stringify(parsed))}};
}
export const policySample=()=>`# 差旅制度\n\n## 费用标准\n\n| 城市 | 住宿上限 | 餐补上限 |\n|---|---|---|\n${Array.from({length:100},(_,i)=>`| 城市${String(i+1).padStart(3,'0')} | ${300+i}元 | ${50+i}元 |`).join('\n')}\n\n## 审批流程\n\n报销必须提交发票和出差审批单。\n\n特殊超标住宿须经部门主管提前书面审批。\n\n## 归档\n\n原始凭证在财务系统保存五年。`;
