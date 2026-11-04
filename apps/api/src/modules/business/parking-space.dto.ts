import { Transform } from 'class-transformer';
import { IsDateString, IsString, Matches, MaxLength, ValidateBy, ValidateIf } from 'class-validator';
import { isValidFamilyPlate } from '../access-card-issuance/family-car.util';

// 不将 null/数字/对象强转字符串；省略=不修改，空字符串=清空，null=非法输入。
const Trim = () => Transform(({ value }) => typeof value === 'string' ? value.trim() : value);
const Present = () => ValidateIf((_object, value) => value !== undefined);

/** 仅更新车位本地档案，不创建停车系统续期任务。 */
export class UpdateParkingSpaceDto {
  @Present()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase().replace(/\s/g, '') : value)
  @IsString({ message: '车牌必须为字符串，清空请传空字符串' })
  @MaxLength(20, { message: '车牌不能超过20字' })
  @ValidateBy({ name: 'parkingSpacePlate', validator: {
    validate: (value: unknown) => value === '' || (typeof value === 'string' && isValidFamilyPlate(value)),
    defaultMessage: () => '车牌格式不正确，例如 沪A12345',
  } })
  plate?: string;

  @Present()
  @Trim()
  @IsString({ message: '房号必须为字符串' })
  @MaxLength(60, { message: '房号不能超过60字' })
  houseNo?: string;

  @Present()
  @Trim()
  @IsString({ message: '业主姓名必须为字符串' })
  @MaxLength(60, { message: '业主姓名不能超过60字' })
  ownerName?: string;

  @Present()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().split(/[\/,，、;；\s]+/).filter(Boolean).join('/') : value)
  @IsString({ message: '电话必须为字符串' })
  @MaxLength(30, { message: '电话不能超过30字，多个号码请用 / 分隔' })
  ownerTel?: string;

  @Present()
  @Trim()
  @IsString({ message: '备注必须为字符串' })
  @MaxLength(60, { message: '备注不能超过60字' })
  note?: string;

  @Present()
  @Trim()
  @IsString({ message: '面积必须为字符串' })
  @Matches(/^(?:|\d{1,5}(?:\.\d{1,2})?)$/, { message: '面积应为0至99999.99，最多两位小数；清空请传空字符串' })
  areaSqm?: string;

  @ValidateIf((_object, value) => value !== undefined && value !== '')
  @Trim()
  @IsString({ message: '档案有效期必须为字符串' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '档案有效期格式应为 YYYY-MM-DD' })
  @IsDateString({ strict: true }, { message: '档案有效期必须为真实存在的日期' })
  endDate?: string;
}
