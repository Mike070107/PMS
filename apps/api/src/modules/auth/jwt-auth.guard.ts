import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** 标准 JWT 守卫，挂在需要登录的接口上 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
