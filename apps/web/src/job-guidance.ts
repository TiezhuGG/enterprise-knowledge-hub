import type {IngestionJob} from '@zhiheng/contracts';
const source=new Set(['PDF_ENCRYPTED','PDF_DAMAGED','PDF_PARSE_FAILED','OCR_REQUIRED','DOCX_DAMAGED','DOCX_ENCRYPTED','DOCX_UNSAFE_XML','DOCX_MACRO_UNSUPPORTED','DOCX_ZIP_LIMIT','DOCUMENT_EMPTY','TEXT_INVALID_UTF8','TEXT_ENCODING_UNRELIABLE','SOURCE_INTEGRITY_MISMATCH','SOURCE_REJECTED','CHUNK_TABLE_ROW_TOO_LARGE','CHUNK_TABLE_HEADER_TOO_LARGE','CHUNK_NO_CONTENT']);
export function jobGuidance(job:Pick<IngestionJob,'status'|'error_code'|'stage'>){
 if(job.status==='cancelled')return {label:'已停止',instruction:'取消不会删除原文件或创建新版本。'};
 if(source.has(job.error_code??''))return {label:'原文件需修订',instruction:'先核对原文件；修订后上传新版本。重复重试通常无法修复这些问题。'};
 if(job.error_code==='EMBEDDING_OUTCOME_UNKNOWN')return {label:'模型调用待核对',instruction:'调用结果不明，需由维护者核对记录；不会自动重复调用。'};
 if(job.status==='waiting_dependency')return {label:'等待后续依赖',instruction:job.stage==='awaiting_publication'?'索引已经就绪，安全检查和发布尚未完成。':'当前步骤已保存；需恢复后续处理能力，不能将等待状态当作原文错误。'};
 if(job.error_code==='ACCESS_REVOKED')return {label:'处理权限已变化',instruction:'由有权维护者核对执行身份和文档授权后再处理。'};
 if(job.status==='failed'||job.status==='retry_wait')return {label:'处理服务或资源异常',instruction:'查看失败原因；允许重试时继续同一版本任务，不重复登记原文件。'};
 return {label:job.status==='succeeded'?'处理完成':'正在处理',instruction:'处理记录与原文件版本分别保留；任务状态不代替发布状态。'};
}
