import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FinanceFilesService } from './finance-files.service';
import { FinanceMailService } from './finance-mail.service';
import { FinanceService } from './finance.service';
import { FinanceTaxImportService } from './finance-tax-import.service';
import { FinanceVerificationService } from './finance-verification.service';

@Controller('finance')
@UseGuards(JwtAuthGuard)
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly mail: FinanceMailService,
    private readonly files: FinanceFilesService,
    private readonly taxImport: FinanceTaxImportService,
    private readonly verification: FinanceVerificationService,
  ) {}

  @Get('access') access(@CurrentUser() user: AuthUser) { return this.finance.access(user); }
  @Get('dashboard') dashboard(@CurrentUser() user: AuthUser) { return this.finance.dashboard(user); }
  @Get('projects') projects(@CurrentUser() user: AuthUser) { return this.finance.listProjects(user); }
  @Post('projects') createProject(@CurrentUser() user: AuthUser, @Body() dto: any) { return this.finance.createProject(user, dto); }
  @Get('entries') entries(@CurrentUser() user: AuthUser, @Query() query: any) { return this.finance.listEntries(user, query); }
  @Post('entries') createEntry(@CurrentUser() user: AuthUser, @Body() dto: any) { return this.finance.createEntry(user, dto); }
  @Put('entries/:id') updateEntry(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: any) { return this.finance.updateEntry(user, id, dto); }
  @Get('invoices') invoices(@CurrentUser() user: AuthUser, @Query('status') status?: string) { return this.finance.listInvoices(user, status); }
  @Get('invoices/:id/candidates') candidates(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.finance.invoiceCandidates(user, id); }
  @Post('invoices/:id/match') match(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body('entryId', ParseIntPipe) entryId: number) { return this.finance.matchInvoice(user, id, entryId); }
  @Post('invoices/:id/discard') discard(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body('reason') reason?: string) { return this.finance.discardInvoice(user, id, reason); }
  @Post('invoices/:id/restore') restore(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.finance.restoreInvoice(user, id); }
  @Get('invoices/:id/verification-history') verificationHistory(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.verification.history(user, id); }
  @Post('invoices/:id/verify') verifyInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body('provider') provider?: string) { return this.verification.verify(user, id, provider || 'default'); }
  @Get('reimbursements') reimbursements(@CurrentUser() user: AuthUser) { return this.finance.listReimbursements(user); }
  @Post('reimbursements') createReimbursement(@CurrentUser() user: AuthUser, @Body() dto: any) { return this.finance.createReimbursement(user, dto); }
  @Post('reimbursements/:id/paid') markPaid(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) { return this.finance.markReimbursementPaid(user, id); }

  @Get('mail-connection') mailConnection(@CurrentUser() user: AuthUser) { return this.mail.getConnection(user); }
  @Put('mail-connection') saveMailConnection(@CurrentUser() user: AuthUser, @Body() dto: any) { return this.mail.saveConnection(user, dto); }
  @Post('mail-connection/test') testMail(@CurrentUser() user: AuthUser, @Body() dto: any) { return this.mail.test(user, dto); }
  @Post('mail-connection/sync') syncMail(@CurrentUser() user: AuthUser) { return this.mail.syncNow(user); }

  @Post('attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  uploadAttachment(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) { return this.files.uploadAttachment(user, file); }

  @Post('invoices/upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  uploadInvoice(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) { return this.files.uploadInvoice(user, file); }

  @Get('tax-account-imports') taxAccountImports(@CurrentUser() user: AuthUser) { return this.taxImport.listBatches(user); }

  @Post('tax-account-imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  importTaxAccount(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) { return this.taxImport.importExport(user, file); }

  @Get('files')
  async readFile(@CurrentUser() user: AuthUser, @Query('key') key: string, @Res({ passthrough: true }) response: Response) {
    const file = await this.files.read(user, key);
    if (file.contentType) response.setHeader('Content-Type', file.contentType);
    if (file.contentLength) response.setHeader('Content-Length', String(file.contentLength));
    response.setHeader('Content-Disposition', 'inline');
    return new StreamableFile(file.stream);
  }
}
