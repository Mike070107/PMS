import {Body,Controller,Get,Param,ParseIntPipe,Post,UseGuards} from '@nestjs/common';
import {AuthUser,CurrentUser} from '../../common/current-user.decorator';import {CurrentAccess} from '../access/current-access.decorator';import {ResolvedAccess} from '../access/access.service';import {RequirePermission} from '../../common/require-permission.decorator';import {JwtAuthGuard} from '../auth/jwt-auth.guard';import {PermissionsGuard} from '../access/permissions.guard';
import {MisPostingService} from './mis-posting.service';import {CreateMisPostingDto} from './mis-posting.dto';
@UseGuards(JwtAuthGuard,PermissionsGuard)
@Controller('fees/mis/postings')
export class MisPostingController{
 constructor(private readonly posting:MisPostingService){}
 @Post() @RequirePermission('fees','edit')
 async create(@Body() dto:CreateMisPostingDto,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){const row=await this.posting.create(dto,user,access);return this.posting.detail(row.id,user,access);}
 @Post(':id/retry') @RequirePermission('fees','edit')
 retry(@Param('id',ParseIntPipe) id:number|string,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.posting.retry(Number(id),user,access);}
 @Get(':id') @RequirePermission('fees','view')
 detail(@Param('id',ParseIntPipe) id:number|string,@CurrentUser() user:AuthUser,@CurrentAccess() access:ResolvedAccess){return this.posting.detail(Number(id),user,access);}
}

