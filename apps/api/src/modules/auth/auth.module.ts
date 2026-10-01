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
  Role,
  Tenant,
  User,
  UserAudit,
  UserReportCommunity,
  UserRoleAssignment,
  WebLoginTicket,
  OidcAuthorizationCode,
  ExternalAccessApp,
  ExternalAccessGrant,
} from '../../entities';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { WechatService } from './wechat.service';
import { QrLoginService } from './qr-login.service';
import { OidcController } from './oidc.controller';
import { OidcService } from './oidc.service';

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
      Role,
      WebLoginTicket,
      OidcAuthorizationCode,
      ExternalAccessApp,
      ExternalAccessGrant,
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
  controllers: [AuthController, OidcController],
  providers: [AuthService, JwtStrategy, WechatService, OidcService, QrLoginService],
  exports: [JwtModule, PassportModule, WechatService, QrLoginService],
})
export class AuthModule {}
