import {Controller,Get,Query,UseGuards} from '@nestjs/common';import {AuthUser,CurrentUser} from '../../common/current-user.decorator';import {RequirePermission} from '../../common/require-permission.decorator';import {ResolvedAccess} from '../access/access.service';import {CurrentAccess} from '../access/current-access.decorator';import {JwtAuthGuard} from '../auth/jwt-auth.guard';import {PermissionsGuard} from '../access/permissions.guard';import {BusinessLedgerService} from './business-ledger.service';import {BusinessLedgerQueryDto} from './business-ledger.dto';
@Controller('business/transaction-ledger') @UseGuards(JwtAuthGuard,PermissionsGuard)
export class BusinessLedgerController{
 constructor(private readonly ledger:BusinessLedgerService){}
 @Get() @RequirePermission('business','view')
 list(@Query() q:BusinessLedgerQueryDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.ledger.list(q,user,access);}
}
