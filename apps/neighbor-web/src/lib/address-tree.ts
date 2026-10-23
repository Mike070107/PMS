import { useEffect, useMemo, useState } from 'react';
import type { AddressCommunity } from '@pms/shared-types';
import { address } from '@pms/api-client';
import { useSession } from '@/lib/auth';

let cache: AddressCommunity[] | null = null;
let inflight: Promise<AddressCommunity[]> | null = null;

/**
 * 地址树：全局只拉一次，各页面共用。
 * 服务端按当前身份与「管理处视角」返回可访问范围，前端再按 access.communityIds 收一遍。
 */
export function useAddressTree() {
  const session = useSession();
  const [tree, setTree] = useState<AddressCommunity[] | null>(cache);
  const [error, setError] = useState('');

  useEffect(() => {
    if (cache) return;
    if (!inflight) inflight = address.tree();
    let alive = true;
    inflight
      .then((t) => { cache = t; if (alive) setTree(t); })
      .catch((e) => { inflight = null; if (alive) setError(e instanceof Error ? e.message : '地址加载失败'); });
    return () => { alive = false; };
  }, []);

  const communities = useMemo(() => {
    const list = (tree ?? []).filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const allow = new Set(a.communityIds ?? []);
    return list.filter((c) => allow.has(c.id));
  }, [tree, session.access]);

  return { tree, communities, error };
}
