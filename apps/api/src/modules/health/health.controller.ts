import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 发布脚本生成；只公开版本身份，绝不读取环境变量或数据库配置。
function releaseInfo() {
  try {
    const data = JSON.parse(readFileSync(resolve(__dirname, '../../release.json'), 'utf8'));
    if (data.target !== 'api' || !/^[a-f0-9]{40}$/.test(data.commit) || !/^[a-f0-9]{64}$/.test(data.sourceHash)) return null;
    return { target: data.target, version: data.version, commit: data.commit, sourceHash: data.sourceHash, builtAt: data.builtAt };
  } catch { return null; } // 本地开发没有发布清单，不能伪造生产版本。
}

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    let db = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }
    response.status(db === 'up' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: db === 'up' ? 'ok' : 'error',
      db,
      release: releaseInfo(),
      ts: new Date().toISOString(),
    };
  }
}
