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
  Matches,
  ValidateIf,
  ValidateNested,
  ArrayMaxSize,
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

// ─── Holidays (admin CRUD — Owner/HR via @Roles('admin')) ────────────────────

export const HOLIDAY_TYPES = [
  'national',
  'regional',
  'optional',
  'restricted',
  'company',
] as const;
export type HolidayTypeValue = (typeof HOLIDAY_TYPES)[number];

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

export class CreateHolidayDto {
  @ApiProperty({ example: '2026-11-08' })
  @IsString()
  @Matches(DATE_YMD, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ example: 'Diwali' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ enum: HOLIDAY_TYPES, default: 'company' })
  @IsIn(HOLIDAY_TYPES as unknown as string[])
  @IsOptional()
  type?: HolidayTypeValue;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    description:
      'Location the holiday applies to. Omit for a company-wide holiday (all locations).',
  })
  @IsUUID()
  @IsOptional()
  locationId?: string;

  @ApiPropertyOptional({ default: false, description: 'Repeats yearly (fixed-date holidays)' })
  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;
}

export class UpdateHolidayDto {
  @ApiPropertyOptional({ example: '2026-11-08' })
  @IsString()
  @IsOptional()
  @Matches(DATE_YMD, { message: 'date must be YYYY-MM-DD' })
  date?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: HOLIDAY_TYPES })
  @IsIn(HOLIDAY_TYPES as unknown as string[])
  @IsOptional()
  type?: HolidayTypeValue;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;

  // null = make it company-wide again; undefined = leave unchanged.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((o: UpdateHolidayDto) => o.locationId !== null)
  @IsUUID()
  locationId?: string | null;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;
}

export class ImportHolidayItemDto {
  @ApiProperty({ example: '2026-01-26' })
  @IsString()
  @Matches(DATE_YMD, { message: 'date must be YYYY-MM-DD' })
  date: string;

  @ApiProperty({ example: 'Republic Day' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ enum: HOLIDAY_TYPES, default: 'national' })
  @IsIn(HOLIDAY_TYPES as unknown as string[])
  @IsOptional()
  type?: HolidayTypeValue;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;
}

export class ImportHolidaysDto {
  @ApiProperty({ type: [ImportHolidayItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ImportHolidayItemDto)
  holidays: ImportHolidayItemDto[];

  @ApiPropertyOptional({
    description: 'Assign every imported holiday to this location. Omit for company-wide.',
  })
  @IsUUID()
  @IsOptional()
  locationId?: string;
}
