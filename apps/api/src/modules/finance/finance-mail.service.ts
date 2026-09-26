import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { Interval } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { ObjectStorageService } from '../upload/object-storage.service';
import { decryptFinanceSecret, encryptFinanceSecret, resolveFinanceKey } from './finance.crypto';
import { FinanceInvoice, FinanceMailConnection, FinanceMailMessage } from './finance.entities';
import { FinanceRecognitionService } from './finance-recognition.service';
import { isPdfAttachment, maskEmail, sha256 } from './finance.util';
import { FinanceService } from './finance.service';

@Injectable()
export class FinanceMailService {
  private readonly logger = new Logger(FinanceMailService.name);
  private running = new Set<number>();
  constructor(
    @InjectRepository(FinanceMailConnection, 'finance') private readonly connRepo: Repository<FinanceMailConnection>,
    @InjectRepository(FinanceMailMessage, 'finance') private readonly messageRepo: Repository<FinanceMailMessage>,
    @InjectRepository(FinanceInvoice, 'finance') private readonly invoiceRepo: Repository<FinanceInvoice>,
    private readonly finance: FinanceService,
    private readonly config: ConfigService,
    private readonly storage: ObjectStorageService,
    private readonly recognition: FinanceRecognitionService,
  ) {}

  async getConnection(user: AuthUser) {
    const tenantId = await this.finance.assertAllowed(user);
    const connection = await this.connRepo.findOne({ where: { tenantId } });
    return connection ? { id: connection.id, emailMasked: maskEmail(connection.email), enabled: connection.enabled, initialSyncDays: connection.initialSyncDays, lastSuccessAt: connection.lastSuccessAt, lastError: connection.lastError } : null;
  }

  async saveConnection(user: AuthUser, dto: any) {
    const tenantId = await this.finance.assertAllowed(user);
    const email = String(dto.email ?? '').trim().toLowerCase();
    const secret = String(dto.authorizationCode ?? '').trim();
    if (!/^\d{5,12}@qq\.com$/i.test(email)) throw new BadRequestException('请填写正确的 QQ 邮箱地址');
    const existing = await this.connRepo.findOne({ where: { tenantId } });
    if (!existing && !secret) throw new BadRequestException('首次连接请填写 IMAP 授权码');
    let key: Buffer;
    try { key = resolveFinanceKey(this.config.get<string>('FINANCE_SECRET_KEY', '')); }
    catch { throw new BadRequestException('服务器尚未配置财务密钥 FINANCE_SECRET_KEY，无法安全保存邮箱授权码'); }
    const row = existing ?? this.connRepo.create({ tenantId, host: 'imap.qq.com', port: 993, initialSyncDays: 7, lastUid: null, uidValidity: null, lastSuccessAt: null, lastError: null, createdBy: user.id });
    row.email = email; row.enabled = dto.enabled !== false; row.updatedBy = user.id;
    if (secret) row.secretCiphertext = encryptFinanceSecret(secret, key);
    return this.connRepo.save(row).then(() => this.getConnection(user));
  }

  async test(user: AuthUser, dto?: any) {
    const tenantId = await this.finance.assertAllowed(user);
    const saved = await this.connRepo.findOne({ where: { tenantId } });
    const email = String(dto?.email ?? saved?.email ?? '').trim();
    let secret = String(dto?.authorizationCode ?? '').trim();
    if (!secret && saved) secret = this.decrypt(saved.secretCiphertext);
    if (!email || !secret) throw new BadRequestException('请先填写邮箱和授权码');
    const client = this.client(email, secret);
    try { await client.connect(); await client.mailboxOpen('INBOX', { readOnly: true }); return { ok: true, message: '连接成功，邮箱只读访问正常' }; }
    catch (error) { throw new BadRequestException(`QQ 邮箱连接失败：${this.safeError(error)}`); }
    finally { try { await client.logout(); } catch {} }
  }

  async syncNow(user: AuthUser) {
    const tenantId = await this.finance.assertAllowed(user);
    return this.syncTenant(tenantId, user.id);
  }

  @Interval(5 * 60 * 1000)
  async syncEnabledConnections() {
    const connections = await this.connRepo.find({ where: { enabled: true } });
    for (const connection of connections) {
      try { await this.syncTenant(connection.tenantId, null); }
      catch { /* 单个邮箱失败已落 lastError，不能阻断其他租户 */ }
    }
  }

  async syncTenant(tenantId: number, actorId: number | null) {
    if (this.running.has(tenantId)) return { ok: true, running: true, imported: 0 };
    const connection = await this.connRepo.findOne({ where: { tenantId, enabled: true } });
    if (!connection) throw new BadRequestException('请先连接 QQ 邮箱');
    this.running.add(tenantId);
    let client: ImapFlow | null = null;
    let imported = 0;
    try {
      client = this.client(connection.email, this.decrypt(connection.secretCiphertext));
      await client.connect();
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const mailbox: any = client.mailbox;
        const uidValidity = String(mailbox?.uidValidity ?? '0');
        const uidNext = Number(mailbox?.uidNext ?? 1);
        let startUid = connection.uidValidity === uidValidity && connection.lastUid ? connection.lastUid + 1 : 1;
        const cutoff = new Date(Date.now() - connection.initialSyncDays * 86_400_000);
        if (!connection.lastUid) {
          const searchResult = await client.search({ since: cutoff }, { uid: true });
          const matches = Array.isArray(searchResult) ? searchResult : [];
          if (matches.length) startUid = Math.min(...matches);
          else startUid = uidNext;
        }
        const endUid = uidNext - 1;
        if (startUid <= endUid) {
          for await (const message of client.fetch(`${startUid}:${endUid}`, { uid: true, source: true, envelope: true, internalDate: true }, { uid: true })) {
            const uid = Number(message.uid);
            const exists = await this.messageRepo.findOne({ where: { connectionId: connection.id, folder: 'INBOX', uidValidity, uid } });
            if (exists) continue;
            const parsed = await simpleParser(message.source as Buffer);
            const mailRow = await this.messageRepo.save(this.messageRepo.create({ tenantId, connectionId: connection.id, folder: 'INBOX', uidValidity, uid, messageId: parsed.messageId ?? null, subject: parsed.subject?.slice(0, 500) ?? null, sender: parsed.from?.text?.slice(0, 300) ?? null, receivedAt: message.internalDate ?? parsed.date ?? null, status: 'processed', error: null, createdBy: actorId, updatedBy: actorId }));
            for (const attachment of parsed.attachments) {
              if (!isPdfAttachment(attachment.filename ?? '', attachment.contentType)) continue;
              const hash = sha256(attachment.content);
              if (await this.invoiceRepo.findOne({ where: { tenantId, sha256: hash } })) continue;
              const filename = attachment.filename ?? 'invoice.pdf';
              const recognized = await this.recognition.recognize(tenantId, filename, attachment.contentType, attachment.content);
              const sameIdentity = recognized.invoiceCode && recognized.invoiceNo
                ? await this.invoiceRepo.findOne({ where: { tenantId, invoiceCode: recognized.invoiceCode, invoiceNo: recognized.invoiceNo } })
                : null;
              const stored = await this.storage.putBuffer(attachment.content, attachment.contentType || 'application/octet-stream', `finance-invoices/t${tenantId}`, attachment.filename);
              const { status: recognitionStatus, source: recognitionSource, confidence: recognitionConfidence, raw, ...fields } = recognized;
              await this.invoiceRepo.save(this.invoiceRepo.create({ tenantId, source: 'email', originalName: filename.slice(0, 255), objectKey: stored.objectKey, sha256: hash, status: sameIdentity ? 'duplicate' : 'inbox', ...fields, entryId: null, sourceMessageId: mailRow.id, matchReason: sameIdentity ? `与发票 #${sameIdentity.id} 的代码和号码重复` : null, discardReason: null, recognitionRaw: { ...raw, subject: parsed.subject ?? null }, recognitionStatus, recognitionSource, recognitionConfidence, verificationStatus: 'unverified', verifiedAt: null, verificationSource: null, verificationMessage: null, createdBy: actorId, updatedBy: actorId }));
              imported++;
            }
            connection.lastUid = Math.max(connection.lastUid ?? 0, uid);
          }
        }
        connection.uidValidity = uidValidity; connection.lastSuccessAt = new Date(); connection.lastError = null; connection.updatedBy = actorId;
        await this.connRepo.save(connection);
      } finally { lock.release(); }
      return { ok: true, running: false, imported };
    } catch (error) {
      connection.lastError = this.safeError(error).slice(0, 1000); await this.connRepo.save(connection);
      this.logger.warn(`Finance mail sync tenant=${tenantId} failed: ${connection.lastError}`);
      throw new BadRequestException(`邮箱同步失败：${connection.lastError}`);
    } finally { try { await client?.logout(); } catch {}; this.running.delete(tenantId); }
  }

  private decrypt(value: string) { return decryptFinanceSecret(value, resolveFinanceKey(this.config.get<string>('FINANCE_SECRET_KEY', ''))); }
  private client(email: string, pass: string) { return new ImapFlow({ host: 'imap.qq.com', port: 993, secure: true, auth: { user: email, pass }, logger: false }); }
  private safeError(error: unknown) { const message = error instanceof Error ? error.message : String(error); return message.replace(/[a-z0-9]{12,20}/gi, '***').slice(0, 500); }
}
