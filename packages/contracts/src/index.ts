/** Public process liveness; does not claim database, index or model readiness. */
export interface HealthResponse {
  service: 'api';
  status: 'ok';
  timestamp: string;
}
export const DEVELOPMENT_QUEUE = 'development-smoke';
export const DEVELOPMENT_JOB = 'ping';
export interface DevelopmentPing { nonce: string }

export interface IdentityContext {
  actor_id: string;
  tenant_id: string;
  membership_id: string;
  role: MemberRole;
  capabilities: readonly string[];
  provider: 'development';
}
export interface SessionInfo {
  identity: IdentityContext;
  display_name: string;
  expires_at: string;
  csrf_token: string;
}
export interface DataResponse<T> { data: T }

export type MemberRole = 'employee' | 'operator' | 'admin' | 'auditor';
export const RESOURCE_ACTIONS = ['read', 'download', 'write', 'publish', 'delete', 'manage', 'manage_acl'] as const;
export type ResourceAction = typeof RESOURCE_ACTIONS[number];
export interface ResourceGrant { principal_type: 'member' | 'group'; principal_id: string; actions: ResourceAction[] }
export interface KnowledgeBase {
  id: string; name: string; description: string; status: 'active' | 'archived';
  publish_policy: 'manual'; row_version: number; policy_version: number;
  created_at: string; capabilities: ResourceAction[];
}
export interface KnowledgeDocument {
  id: string; kb_id: string; title: string; status: 'draft' | 'active' | 'archived';
  acl_mode: 'inherit' | 'restricted'; row_version: number; policy_version: number;
  created_at: string; capabilities: ResourceAction[];
}
export interface ResourcePage<T> { data: T[]; page: { next_cursor: string | null; has_more: boolean } }

export interface UploadTicket {
  ticket_id:string; document_id:string; status:'open'|'uploaded'|'finalized'; expires_at:string; max_size:number;
  upload:{method:'PUT';url:string;headers:Record<string,string>}; finalize_url:string;
}
export interface FinalizedUpload {document_id:string;version_id:string;version_no:number;job_id:string;status:IngestionStatus;status_url:string}
export interface DocumentVersion {id:string;document_id:string;version_no:number;filename:string;size:number;mime:string;sha256:string;scan_status:'pending'|'clean'|'rejected';created_at:string;is_latest:boolean;is_published:boolean}

export const INGEST_JOB_NAME='ingest-version';
export type IngestionStatus='queued'|'running'|'retry_wait'|'waiting_dependency'|'succeeded'|'failed'|'cancelled';
export interface IngestionDelivery {tenant_id:string;job_id:string;revision:number}
export interface IngestionJob {
  id:string;kb_id:string;document_id:string;version_id:string;version_no:number;pipeline_version:string;
  status:IngestionStatus;stage:string;error_code:string|null;dead_letter:boolean;
  run_no:number;attempt_count:number;total_attempts:number;max_attempts:number;progress:null;
  next_run_at:string|null;cancel_requested:boolean;created_at:string;updated_at:string;
}
export interface IngestionDetails extends IngestionJob {
  attempts:Array<{run_no:number;attempt_no:number;status:string;error_code:string|null;started_at:string;ended_at:string|null}>;
  events:Array<{seq:number;run_no:number;status:string;stage:string;error_code:string|null;occurred_at:string}>;
}

export type ParsedKind='heading'|'paragraph'|'list_item'|'table'|'code'|'header'|'footer';
export interface SourceLocation {
  type:'text'|'pdf'|'docx';char_start?:number;char_end?:number;line_start?:number;line_end?:number;
  page?:number;bbox?:[number,number,number,number];page_width?:number;page_height?:number;
  part?:string;paragraph_index?:number;table_index?:number;row_index?:number;cell_index?:number;
}
export interface ParsedCell {text:string;col_span:number;v_merge?:'restart'|'continue';source?:SourceLocation}
export interface ParsedBlock {id?:string;ordinal:number;kind:ParsedKind;text:string;heading_path:string[];source:SourceLocation;level?:number;table?:{header_rows:number;rows:ParsedCell[][]}}
export interface ParseWarning {code:string;severity:'info'|'review';page?:number;part?:string}
export interface ParsedDocument {
  parser_version:string;source_sha256:string;format:'txt'|'markdown'|'pdf'|'docx';page_count:number|null;
  blocks:ParsedBlock[];warnings:ParseWarning[];
  metrics:{characters:number;blocks:number;tables:number;empty_pages:number;replacement_characters:number};
}
export interface ParsedPreview {document_id:string;version_id:string;result:ParsedDocument;page:{next_cursor:string|null;has_more:boolean};total_blocks:number}

export const STRUCTURE_PARSER_VERSION='structure-v1';

export const CHUNKER_VERSION='structure-chunks-v1';
export interface ChunkScope {
 tenant_id:string;kb_id:string;document_id:string;version_id:string;version_no:number;source_asset_id:string;
 source_sha256:string;parser_version:string;parsed_artifact_sha256:string;
}
export interface ChunkSpan {
 block_id:string;block_ordinal:number;start:number;end:number;source:SourceLocation;
 role:'body'|'table_header';row_start?:number;row_end?:number;
}
export interface KnowledgeChunk {
 id:string;ordinal:number;kind:'text'|'table'|'code';text:string;retrieval_text:string;text_sha256:string;retrieval_sha256:string;
 heading_path:string[];spans:ChunkSpan[];overlap_characters:number;
 table?:{header_rows:number;rows:ParsedCell[][];row_start:number;row_end:number};
 provenance:ChunkScope;permission_source:{type:'current_document_acl';tenant_id:string;kb_id:string;document_id:string};
}
export interface ChunkSet {
 chunker_version:string;scope:ChunkScope;
 policy:{strategy:'structure-v1'|'fixed-window-v1';max_characters:number;overlap_characters:number;heading_context_characters:number;offset_unit:'utf16'};
 chunks:KnowledgeChunk[];warnings:Array<{code:string;block_id?:string}>;source_warnings:ParseWarning[];
 metrics:{chunks:number;exact_duplicate_chunks:number;duplicate_ratio:number;overlap_characters:number;repeated_table_header_characters:number;retrieval_characters:number;max_chunk_characters:number;excluded_header_footer_blocks:number};
}
export interface ChunkPreview {document_id:string;version_id:string;result:ChunkSet;total_chunks:number;page:{next_cursor:string|null;has_more:boolean}}

export interface DenseGenerationView {
 id:string;version_id:string;generation_no:number;profile_hash:string;model:string;revision:string;dimension:number;processing:string;
 status:'building'|'ready'|'failed'|'cancelled';chunk_count:number;indexed_count:number;cache_hits:number;provider_inputs:number;tokens:string|null;
 required_artifacts:['dense'];created_at:string;ready_at:string|null;
}
