import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
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

  @Get()
  list(@CurrentUser() user: AuthUser) { return this.service.list(user); }

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
}
