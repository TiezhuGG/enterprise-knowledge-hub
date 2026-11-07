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
export interface FinalizedUpload {document_id:string;version_id:string;version_no:number;status:'awaiting_processing';status_url:string}
export interface DocumentVersion {id:string;document_id:string;version_no:number;filename:string;size:number;mime:string;sha256:string;scan_status:'pending'|'clean'|'rejected';created_at:string;is_latest:boolean;is_published:boolean}
