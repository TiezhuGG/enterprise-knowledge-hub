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
  role: 'employee';
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
