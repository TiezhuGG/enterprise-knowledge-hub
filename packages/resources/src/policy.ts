import { RESOURCE_ACTIONS, type IdentityContext, type MemberRole, type ResourceAction } from '@zhiheng/contracts';

export const ROLE_ACTIONS: Record<MemberRole, readonly ResourceAction[]> = {
  employee: ['read', 'download'], auditor: ['read', 'download'],
  operator: RESOURCE_ACTIONS, admin: RESOURCE_ACTIONS,
};
/** Explicit allowlist only. Roles never supply resource access by themselves. */
export function allowedActions(identity: IdentityContext, grants: readonly ResourceAction[]): ResourceAction[] {
  return RESOURCE_ACTIONS.filter(action => ROLE_ACTIONS[identity.role].includes(action) && grants.includes(action));
}
export class ResourceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function fail(status: number, code: string): never { throw new ResourceError(status, code); }
