// Synthetic identity for the access-card status fixture. Never a real credential.
export const session: any = {
  token: 'SYNTHETIC-NOT-A-CREDENTIAL',
  generation: 1,
  user: { id: 7, name: '隔离账号', tenantId: 1 },
  actingTenant: { id: 1 },
  access: { scopeAll: true, communityIds: [], pages: { business: { view: true, edit: true } } },
};
export const useSession = () => session;
export const can = (key: string, action = 'view') => session.access?.pages?.[key]?.[action] === true;
export const auth = {
  getUser: () => session.user,
  getAccess: () => session.access,
  captureIdentity: () => ({ token: session.token, generation: session.generation }),
  isCurrent: (identity: any) => identity.generation === session.generation,
  clear() {},
  setAccess(access: any) { session.access = access; },
};
