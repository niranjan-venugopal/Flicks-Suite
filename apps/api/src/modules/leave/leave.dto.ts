import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsUUID,
  IsArray,
  IsUrl,
  IsNumber,
  IsIn,
  Min,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const HALF_DAY_SESSIONS = ['first_half', 'second_half'] as const;
export type HalfDaySession = (typeof HALF_DAY_SESSIONS)[number];

// ─── Apply / Cancel / Review ─────────────────────────────────────────────────

export class ApplyLeaveDto {
  @ApiProperty()
  @IsUUID()
  leaveTypeId: string;

  @ApiProperty({ example: '2026-05-20' })
  @IsString()
  @IsNotEmpty()
  startDate: string;

  @ApiProperty({ example: '2026-05-22' })
  @IsString()
  @IsNotEmpty()
  endDate: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isHalfDay?: boolean = false;

  @ApiPropertyOptional({ enum: HALF_DAY_SESSIONS })
  @IsIn(HALF_DAY_SESSIONS as unknown as string[])
  @IsOptional()
  halfDaySession?: HalfDaySession;

  @ApiProperty({ example: 'Family wedding ceremony' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  coverEmployeeId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsUrl({}, { each: true })
  @IsOptional()
  documentUrls?: string[];
}

export class CancelLeaveDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MinLength(5)
  @MaxLength(500)
  reason?: string;
}

export class ReviewLeaveDto {
  @ApiProperty({ enum: ['approve', 'reject'] })
  @IsIn(['approve', 'reject'])
  action: 'approve' | 'reject';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  comment?: string;
}

// ─── Leave Types ─────────────────────────────────────────────────────────────

export class CreateLeaveTypeDto {
  @ApiProperty({ example: 'Casual Leave' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'CL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 12 })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  defaultQuotaDays: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;
}

// ─── Listing ─────────────────────────────────────────────────────────────────

export class LeaveListQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  fromDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  toDate?: string;

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
