import { SettingsModule } from '../settings/settings.module';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Building,
  Community,
  House,
  Tenant,
  User,
  UserAudit,
  UserReportCommunity,
  UserRoleAssignment,
} from '../../entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { WechatService } from './wechat.service';

@Module({
  imports: [
    SettingsModule,
    PassportModule,
    TypeOrmModule.forFeature([
      User,
      Tenant,
      Community,
      Building,
      House,
      UserAudit,
      UserReportCommunity,
      UserRoleAssignment,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'change-me-in-prod'),
        signOptions: {
          expiresIn: config.get<string>('JWT_ACCESS_EXPIRES_IN', '2h'),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, WechatService],
  exports: [JwtModule, PassportModule, WechatService],
})
export class AuthModule {}
