import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export class GrantSubscribeDto {
  /** 用户点了「允许」的模板 id；一次弹窗最多 3 个，这里放宽到 10 */
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  templateIds: string[];
}
