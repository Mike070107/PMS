const w = window as any;
w.__calls = []; w.__mode = 'success'; w.__rows = [];
const resources = [{ id: 'site.main', label: '合成门禁', capabilities: [{ operation: 'access.query', revision: 1 }] }];
const result = (name: string, request?: any) => {
  w.__calls.push({ name, request });
  return new Promise<any>((resolve, reject) => {
    const finish = () => {
      if (w.__mode === 'error') { reject(Error('合成网络失败：输入已保留')); return; }
      if (name === 'enroll' || name === 'rotate') {
        const row = { key: 'local-synthetic', name: request?.name || '合成服务', kind: 'service', enabled: true, resources, ready: [], protocolVersion: '1.0', version: 'pending', status: 'offline' };
        w.__rows = [row]; resolve({ ...row, token: 'SYNTHETIC-ONE-TIME-SECRET' });
      } else if (name === 'list') resolve(w.__rows);
      else if (name === 'enabled') { w.__rows = w.__rows.map((r: any) => ({ ...r, enabled: request.enabled })); resolve(w.__rows[0]); }
      else if (name === 'legacy') resolve({ name: request.name, token: 'SYNTHETIC-ISSUER-SECRET' });
      else resolve({ agents: [{ id: 'issuer-synthetic', kind: 'issuer', name: '现有工作站', status: 'offline', version: '1', capabilities: {} }], features: {}, simulationEnabled: false });
    };
    if (w.__mode === 'wait') w.__release = finish; else setTimeout(finish, 60);
  });
};
export const localIntegrations = { list: () => result('list'), enroll: (r: any) => result('enroll', r), rotateSecret: () => result('rotate'), setEnabled: (_: string, enabled: boolean) => result('enabled', { enabled }) };
export const accessCardIssuance = { readiness: () => result('readiness'), enrollAgent: (r: any) => result('legacy', r) };
