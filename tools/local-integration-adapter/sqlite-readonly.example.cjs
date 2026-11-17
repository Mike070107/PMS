'use strict';
// A real read-only SQLite reference adapter, not a universal vendor driver.
// Expected local schema: PermitCards(CardNo TEXT, HolderName TEXT, Room TEXT, Enabled INTEGER).
// Change the mapping HERE (or supply another module), never add vendor tables/SQL to PMS requests.
const { DatabaseSync } = require('node:sqlite');
function createAdapter({ databasePath, resourceId = 'site.main' }) {
  const open = () => { if (!databasePath) throw Error('Configure a local database path'); return new DatabaseSync(databasePath, { readOnly: true }); };
  return {
    version: '1.0.0-sqlite-readonly',
    async ready() {
      let db;
      try {
        db = open(); db.prepare('SELECT CardNo, HolderName, Room, Enabled FROM PermitCards LIMIT 0').all();
        return [{ id: resourceId, label: '本地 SQLite 只读门禁', capabilities: [{ operation: 'access.query', revision: 1 }] }];
      } catch { return []; } finally { db?.close(); }
    },
    async execute(task) {
      if (task.resourceId !== resourceId || task.operation !== 'access.query' || task.revision !== 1) return { outcome: 'failed', code: 'UNSUPPORTED_OPERATION', message: '本地适配器只实现本资源的只读门禁查询' };
      if (task.signal.aborted || Date.parse(task.deadline) <= Date.now()) return { outcome: 'unknown', code: 'DEADLINE_EXCEEDED' };
      const column = { card: 'CardNo', room: 'Room', person: 'HolderName' }[task.command.query?.field];
      if (!column || typeof task.command.query.value !== 'string') return { outcome: 'failed', code: 'UNSUPPORTED_QUERY' };
      let db;
      try {
        db = open();
        // column comes ONLY from the local constant allowlist; the business value is always bound.
        const rows = db.prepare(`SELECT CardNo, HolderName, Room, Enabled FROM PermitCards WHERE ${column} = ? LIMIT 100`).all(task.command.query.value);
        return { outcome: 'succeeded', evidence: 'observed', records: rows.map(row => ({ cardNumber: String(row.CardNo), ...(row.HolderName ? { name: String(row.HolderName) } : {}), ...(row.Room ? { room: String(row.Room) } : {}), status: row.Enabled ? 'active' : 'inactive' })) };
      } finally { db?.close(); }
    },
  };
}
module.exports = createAdapter({ databasePath: process.env.SITE_DB_PATH, resourceId: process.env.SITE_RESOURCE_ID || 'site.main' });
module.exports.createAdapter = createAdapter;
