import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../../common/current-user.decorator';
import { User, UserFeedback } from '../../entities';
import { CreateUserFeedbackDto } from './dto';

@Injectable()
export class FeedbackService {
  constructor(
    @InjectRepository(UserFeedback)
    private readonly feedbackRepo: Repository<UserFeedback>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async create(dto: CreateUserFeedbackDto, auth: AuthUser) {
    if (!auth.tenantId) throw new BadRequestException('当前账号没有所属企业');
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('请填写意见或建议');
    if (!!dto.videoUrl !== !!dto.videoDurationSeconds) {
      throw new BadRequestException('视频地址与时长必须同时提交');
    }
    const user = await this.userRepo.findOne({
      where: { id: auth.id, tenantId: auth.tenantId },
      select: ['id', 'name', 'phone'],
    });
    const row = this.feedbackRepo.create({
      tenantId: auth.tenantId,
      userId: auth.id,
      userName: user?.name ?? null,
      userPhone: user?.phone ?? null,
      content,
      imageUrls: dto.imageUrls,
      videoUrl: dto.videoUrl || null,
      videoDurationSeconds: dto.videoDurationSeconds ?? null,
      status: 'pending',
      createdBy: auth.id,
      updatedBy: auth.id,
    });
    const saved = await this.feedbackRepo.save(row);
    return { id: saved.id, createdAt: saved.createdAt };
  }
}
