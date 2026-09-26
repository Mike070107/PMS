import { Column, Entity, Index, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

abstract class FinanceTenantEntity {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'tenant_id', type: 'int' }) tenantId: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
  @Column({ name: 'created_by', type: 'int', nullable: true }) createdBy: number | null;
  @Column({ name: 'updated_by', type: 'int', nullable: true }) updatedBy: number | null;
}

@Entity('finance_projects')
@Index(['tenantId', 'parentId'])
export class FinanceProject extends FinanceTenantEntity {
  @Column({ name: 'parent_id', type: 'int', nullable: true }) parentId: number | null;
  @Column({ type: 'varchar', length: 120 }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) attachments: FinanceAttachment[];
  @Column({ type: 'varchar', length: 20, default: 'active' }) status: 'active' | 'archived';
}

export interface FinanceAttachment {
  name: string;
  objectKey: string;
  contentType?: string;
  size?: number;
}

@Entity('finance_entries')
@Index(['tenantId', 'businessDate'])
@Index(['tenantId', 'reimbursementStatus'])
@Index(['tenantId', 'entryNo'], { unique: true })
export class FinanceEntry extends FinanceTenantEntity {
  @Column({ name: 'entry_no', type: 'varchar', length: 32 }) entryNo: string;
  @Column({ name: 'business_date', type: 'date' }) businessDate: string;
  @Column({ type: 'varchar', length: 20 }) owner: 'osiris' | 'pruis' | 'personal';
  @Column({ type: 'varchar', length: 500 }) reason: string;
  @Column({ type: 'decimal', precision: 14, scale: 2 }) amount: string;
  @Column({ name: 'flow_type', type: 'varchar', length: 10 }) flowType: 'income' | 'expense';
  @Column({ name: 'payment_method', type: 'varchar', length: 20 }) paymentMethod: 'wechat' | 'alipay' | 'bank' | 'cash';
  @Column({ name: 'project_id', type: 'int', nullable: true }) projectId: number | null;
  @Column({ name: 'sub_project_id', type: 'int', nullable: true }) subProjectId: number | null;
  @Column({ name: 'voucher_attachments', type: 'jsonb', default: () => "'[]'::jsonb" }) voucherAttachments: FinanceAttachment[];
  @Column({ name: 'reimbursement_required', type: 'boolean', default: false }) reimbursementRequired: boolean;
  @Column({ name: 'reimbursement_status', type: 'varchar', length: 20, default: 'not_required' }) reimbursementStatus: 'not_required' | 'pending' | 'reimbursed';
  @Column({ name: 'reimbursed_at', type: 'timestamptz', nullable: true }) reimbursedAt: Date | null;
}

@Entity('finance_invoices')
@Index(['tenantId', 'sha256'], { unique: true })
@Index(['tenantId', 'status'])
export class FinanceInvoice extends FinanceTenantEntity {
  @Column({ type: 'varchar', length: 30 }) source: 'email' | 'upload' | 'tax_account';
  @Column({ name: 'original_name', type: 'varchar', length: 255 }) originalName: string;
  @Column({ name: 'object_key', type: 'varchar', length: 500, nullable: true }) objectKey: string | null;
  @Column({ type: 'varchar', length: 64 }) sha256: string;
  @Column({ type: 'varchar', length: 20, default: 'inbox' }) status: 'inbox' | 'matched' | 'duplicate' | 'discarded' | 'error';
  @Column({ name: 'invoice_code', type: 'varchar', length: 80, nullable: true }) invoiceCode: string | null;
  @Column({ name: 'invoice_no', type: 'varchar', length: 80, nullable: true }) invoiceNo: string | null;
  @Column({ name: 'invoice_date', type: 'date', nullable: true }) invoiceDate: string | null;
  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true }) amount: string | null;
  @Column({ name: 'tax_amount', type: 'decimal', precision: 14, scale: 2, nullable: true }) taxAmount: string | null;
  @Column({ name: 'seller_name', type: 'varchar', length: 200, nullable: true }) sellerName: string | null;
  @Column({ name: 'seller_tax_no', type: 'varchar', length: 40, nullable: true }) sellerTaxNo: string | null;
  @Column({ name: 'buyer_name', type: 'varchar', length: 200, nullable: true }) buyerName: string | null;
  @Column({ name: 'buyer_tax_no', type: 'varchar', length: 40, nullable: true }) buyerTaxNo: string | null;
  @Column({ name: 'entry_id', type: 'int', nullable: true }) entryId: number | null;
  @Column({ name: 'source_message_id', type: 'int', nullable: true }) sourceMessageId: number | null;
  @Column({ name: 'match_reason', type: 'varchar', length: 500, nullable: true }) matchReason: string | null;
  @Column({ name: 'discard_reason', type: 'varchar', length: 500, nullable: true }) discardReason: string | null;
  @Column({ name: 'recognition_raw', type: 'jsonb', nullable: true }) recognitionRaw: Record<string, unknown> | null;
  @Column({ name: 'recognition_status', type: 'varchar', length: 30, default: 'pending' }) recognitionStatus: 'pending' | 'recognized' | 'partial' | 'failed';
  @Column({ name: 'recognition_source', type: 'varchar', length: 50, nullable: true }) recognitionSource: string | null;
  @Column({ name: 'recognition_confidence', type: 'decimal', precision: 5, scale: 2, nullable: true }) recognitionConfidence: string | null;
  @Column({ name: 'verification_status', type: 'varchar', length: 30, default: 'unverified' }) verificationStatus: 'unverified' | 'pending' | 'verified' | 'failed' | 'exception';
  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true }) verifiedAt: Date | null;
  @Column({ name: 'verification_source', type: 'varchar', length: 80, nullable: true }) verificationSource: string | null;
  @Column({ name: 'verification_message', type: 'varchar', length: 1000, nullable: true }) verificationMessage: string | null;
}

@Entity('finance_invoice_verifications')
@Index(['tenantId', 'invoiceId', 'createdAt'])
export class FinanceInvoiceVerification extends FinanceTenantEntity {
  @Column({ name: 'invoice_id', type: 'int' }) invoiceId: number;
  @Column({ type: 'varchar', length: 30 }) status: 'pending' | 'verified' | 'failed' | 'exception';
  @Column({ type: 'varchar', length: 80 }) source: string;
  @Column({ name: 'checked_at', type: 'timestamptz' }) checkedAt: Date;
  @Column({ type: 'varchar', length: 1000, nullable: true }) message: string | null;
  @Column({ name: 'request_snapshot', type: 'jsonb', nullable: true }) requestSnapshot: Record<string, unknown> | null;
  @Column({ name: 'response_snapshot', type: 'jsonb', nullable: true }) responseSnapshot: Record<string, unknown> | null;
}

@Entity('finance_tax_import_batches')
@Index(['tenantId', 'createdAt'])
export class FinanceTaxImportBatch extends FinanceTenantEntity {
  @Column({ name: 'original_name', type: 'varchar', length: 255 }) originalName: string;
  @Column({ type: 'varchar', length: 30, default: 'completed' }) status: 'completed' | 'partial' | 'failed';
  @Column({ name: 'total_rows', type: 'int', default: 0 }) totalRows: number;
  @Column({ name: 'imported_rows', type: 'int', default: 0 }) importedRows: number;
  @Column({ name: 'updated_rows', type: 'int', default: 0 }) updatedRows: number;
  @Column({ name: 'skipped_rows', type: 'int', default: 0 }) skippedRows: number;
  @Column({ name: 'failed_rows', type: 'int', default: 0 }) failedRows: number;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) errors: Array<{ row: number; message: string }>;
}

@Entity('finance_mail_connections')
@Index(['tenantId'], { unique: true })
export class FinanceMailConnection extends FinanceTenantEntity {
  @Column({ type: 'varchar', length: 160 }) email: string;
  @Column({ name: 'secret_ciphertext', type: 'text' }) secretCiphertext: string;
  @Column({ type: 'varchar', length: 160, default: 'imap.qq.com' }) host: string;
  @Column({ type: 'int', default: 993 }) port: number;
  @Column({ type: 'boolean', default: true }) enabled: boolean;
  @Column({ name: 'initial_sync_days', type: 'int', default: 7 }) initialSyncDays: number;
  @Column({ name: 'uid_validity', type: 'varchar', length: 40, nullable: true }) uidValidity: string | null;
  @Column({ name: 'last_uid', type: 'int', nullable: true }) lastUid: number | null;
  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true }) lastSuccessAt: Date | null;
  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true }) lastError: string | null;
}

@Entity('finance_mail_messages')
@Index(['connectionId', 'folder', 'uidValidity', 'uid'], { unique: true })
export class FinanceMailMessage extends FinanceTenantEntity {
  @Column({ name: 'connection_id', type: 'int' }) connectionId: number;
  @Column({ type: 'varchar', length: 120, default: 'INBOX' }) folder: string;
  @Column({ name: 'uid_validity', type: 'varchar', length: 40 }) uidValidity: string;
  @Column({ type: 'int' }) uid: number;
  @Column({ name: 'message_id', type: 'varchar', length: 500, nullable: true }) messageId: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true }) subject: string | null;
  @Column({ type: 'varchar', length: 300, nullable: true }) sender: string | null;
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true }) receivedAt: Date | null;
  @Column({ type: 'varchar', length: 20, default: 'processed' }) status: 'processed' | 'skipped' | 'error';
  @Column({ type: 'varchar', length: 1000, nullable: true }) error: string | null;
}

@Entity('finance_reimbursements')
@Index(['tenantId', 'applicationNo'], { unique: true })
export class FinanceReimbursement extends FinanceTenantEntity {
  @Column({ name: 'application_no', type: 'varchar', length: 32 }) applicationNo: string;
  @Column({ name: 'claimant_name', type: 'varchar', length: 80 }) claimantName: string;
  @Column({ type: 'varchar', length: 30 }) phone: string;
  @Column({ name: 'application_date', type: 'date' }) applicationDate: string;
  @Column({ name: 'bank_name', type: 'varchar', length: 120 }) bankName: string;
  @Column({ name: 'bank_account', type: 'varchar', length: 80 }) bankAccount: string;
  @Column({ type: 'varchar', length: 500 }) reason: string;
  @Column({ name: 'entry_ids', type: 'jsonb', default: () => "'[]'::jsonb" }) entryIds: number[];
  @Column({ type: 'decimal', precision: 14, scale: 2 }) amount: string;
  @Column({ type: 'varchar', length: 20, default: 'submitted' }) status: 'submitted' | 'paid' | 'cancelled';
  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true }) paidAt: Date | null;
}

export const financeEntities = [FinanceProject, FinanceEntry, FinanceInvoice, FinanceInvoiceVerification, FinanceTaxImportBatch, FinanceMailConnection, FinanceMailMessage, FinanceReimbursement];
