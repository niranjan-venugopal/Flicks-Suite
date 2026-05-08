import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsUUID,
  IsEnum,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Punch In / Out ──────────────────────────────────────────────────────────

export class PunchDto {
  @ApiPropertyOptional({ example: 12.9716, description: 'Latitude' })
  @IsNumber()
  @IsOptional()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  lat?: number;

  @ApiPropertyOptional({ example: 77.5946, description: 'Longitude' })
  @IsNumber()
  @IsOptional()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  lng?: number;

  @ApiPropertyOptional({ example: 12.5, description: 'GPS accuracy in meters' })
  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  accuracy?: number;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  locationId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}

// ─── Regularization ──────────────────────────────────────────────────────────

export const REGULARIZATION_TYPES = [
  'missing_punch',
  'wrong_time',
  'wfh_request',
  'on_duty',
  'manual_override',
] as const;
export type RegularizationType = (typeof REGULARIZATION_TYPES)[number];

export class RegularizationRequestDto {
  @ApiProperty({ example: '2026-05-08' })
  @IsString()
  @IsNotEmpty()
  attendanceDate: string;

  @ApiProperty({ enum: REGULARIZATION_TYPES })
  @IsIn(REGULARIZATION_TYPES as unknown as string[])
  requestType: RegularizationType;

  @ApiPropertyOptional({ example: '2026-05-08T09:00:00Z' })
  @IsString()
  @IsOptional()
  proposedInTime?: string;

  @ApiPropertyOptional({ example: '2026-05-08T18:00:00Z' })
  @IsString()
  @IsOptional()
  proposedOutTime?: string;

  @ApiProperty({ example: 'Forgot to punch in due to client meeting' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

export class ReviewRegularizationDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  comment?: string;
}

// ─── Listing ──────────────────────────────────────────────────────────────────

export class AttendanceListQueryDto {
  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsString()
  @IsOptional()
  fromDate?: string;

  @ApiPropertyOptional({ example: '2026-05-31' })
  @IsString()
  @IsOptional()
  toDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Type(() => Number)
  limit?: number = 20;
}
