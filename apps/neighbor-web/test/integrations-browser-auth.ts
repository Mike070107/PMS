import { useSyncExternalStore } from 'react';
let session: any = { token: 'SYNTHETIC', generation: 1, user: { id: 7, tenantId: 1 }, access: { scopeAll: true, pages: { business: { view: true, edit: true } } } };
const listeners = new Set<() => void>();
export function useSession() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => session); }
export const can = (key: string, action = 'view') => session.access.pages[key]?.[action] === true;
export const auth = {
  captureIdentity: () => ({ generation: session.generation }), isCurrent: (identity: any) => identity.generation === session.generation,
};
(window as any).__switchIdentity = (fullScope = true) => { session = { ...session, generation: session.generation + 1, access: { ...session.access, scopeAll: fullScope } }; listeners.forEach(fn => fn()); };
