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
  Res,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { safeStoredContentType } from '../upload/upload.controller';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DeleteExperienceQueryDto, ExperienceLibraryQueryDto, SaveRepairExperienceNoteDto } from './dto';
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

  @Get('library')
  library(@CurrentUser() user: AuthUser, @Query() query: ExperienceLibraryQueryDto) { return this.service.library(user, query); }

  @Get('sharing-options')
  sharingOptions(@CurrentUser() user: AuthUser) { return this.service.sharingOptions(user); }

  @Post('assets')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  uploadAsset(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthUser) { return this.service.uploadAsset(file, user); }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Query() query: DeleteExperienceQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, query.revision, user);
  }

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

/** Only this capability endpoint is anonymous; every document/upload route remains JWT guarded. */
@Controller('repair-experiences/assets')
export class RepairExperienceAssetsController {
  constructor(private readonly service: RepairExperiencesService) {}

  @Get('view')
  async view(@Query() query: Record<string, string>, @Res() res: Response) {
    const object = await this.service.readAsset(query);
    res.setHeader('Content-Type', safeStoredContentType(object.contentType));
    if (object.contentLength) res.setHeader('Content-Length', String(object.contentLength));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    object.stream.on('error', () => res.destroy());
    object.stream.pipe(res);
  }
}
