import type { IdentityContext } from '@zhiheng/contracts';

// Isolated fixtures, never production identities. Client fields cannot change these bindings.
const accounts = {
  employee: { actor_id: '10000000-0000-4000-8000-000000000001', tenant_id: '20000000-0000-4000-8000-000000000001', membership_id: '30000000-0000-4000-8000-000000000001', display_name: '开发员工' },
  other: { actor_id: '10000000-0000-4000-8000-000000000002', tenant_id: '20000000-0000-4000-8000-000000000002', membership_id: '30000000-0000-4000-8000-000000000002', display_name: '隔离测试员工' },
};
export function developmentIdentity(account: string, disabled: string[]) {
  if (!Object.hasOwn(accounts, account) || disabled.includes(account)) return null;
  const record = accounts[account as keyof typeof accounts];
  const identity: IdentityContext = Object.freeze({ actor_id: record.actor_id, tenant_id: record.tenant_id,
    membership_id: record.membership_id, role: 'employee', capabilities: Object.freeze(['knowledge:read']), provider: 'development' });
  return { identity, display_name: record.display_name };
}
