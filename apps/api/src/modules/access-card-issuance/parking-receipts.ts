import { EventEmitter } from 'node:events';

/** 只在现场回执事务提交后发布；进程间/重启漏通知由5秒扫描兜底。 */
export interface ParkingReceipt {
  tenantId: number;
  kind: 'operation' | 'query';
  id: number;
}
const receipts = new EventEmitter();

export function subscribeParkingReceipts(listener: (receipt: ParkingReceipt) => void): () => void {
  receipts.on('committed', listener);
  return () => { receipts.off('committed', listener); };
}

export function parkingReceiptCommitted(receipt: ParkingReceipt): void {
  // 不阻塞现场助手的报告响应，也不在提交中的事务里推进下一阶段。
  setImmediate(() => { receipts.emit('committed', receipt); });
}
