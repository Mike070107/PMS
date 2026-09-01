import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response) {
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
      ts: new Date().toISOString(),
    };
  }
}
