import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateUserFeedbackDto } from './dto';
import { FeedbackService } from './feedback.service';

@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(private readonly feedbackService: FeedbackService) {}

  @Post()
  create(@Body() dto: CreateUserFeedbackDto, @CurrentUser() user: AuthUser) {
    return this.feedbackService.create(dto, user);
  }
}
