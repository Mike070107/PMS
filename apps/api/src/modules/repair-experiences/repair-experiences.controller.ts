import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SaveRepairExperienceNoteDto } from './dto';
import { RepairExperiencesService } from './repair-experiences.service';

@Controller('repair-experiences')
@UseGuards(JwtAuthGuard)
export class RepairExperiencesController {
  constructor(private readonly service: RepairExperiencesService) {}

  @Get('access')
  access(@CurrentUser() user: AuthUser) { return this.service.access(user); }

  /** q：关键词，只在自己看得到的笔记本里搜标题和正文 */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: string) { return this.service.list(user, q); }

  @Get(':id')
  detail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.detail(id, user);
  }

  @Post()
  create(@Body() dto: SaveRepairExperienceNoteDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveRepairExperienceNoteDto,
    @CurrentUser() user: AuthUser,
  ) { return this.service.update(id, dto, user); }

  /** 收藏一篇：小程序列表默认只展开收藏的 */
  @Post(':id/favorite')
  favorite(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.setFavorite(id, user, true);
  }

  @Delete(':id/favorite')
  unfavorite(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.service.setFavorite(id, user, false);
  }
}
