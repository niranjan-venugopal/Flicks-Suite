import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CONSENT_TYPES, type ConsentType } from '@flicks/shared/constants';

export class ConsentInputDto {
  @IsIn(CONSENT_TYPES)
  type!: ConsentType;

  @IsBoolean()
  granted!: boolean;
}

export class RecordConsentsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsentInputDto)
  consents!: ConsentInputDto[];

  /** Advisory — the client's detected region (ISO alpha-2). */
  @IsOptional()
  @IsString()
  @Length(2, 2)
  region_code?: string;
}

export class BannerSyncDto {
  @IsBoolean()
  analytics!: boolean;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  region_code?: string;
}
