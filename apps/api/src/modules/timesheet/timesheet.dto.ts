import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUUID,
  IsArray,
  ValidateNested,
  IsIn,
  Min,
  Max,
  ArrayMinSize,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Must match timesheet_entry_category in packages/db/src/schema/timesheet.ts —
// the values are written verbatim into the enum column.
export const TIMESHEET_CATEGORIES = [
  'development',
  'design',
  'testing',
  'management',
  'meetings',
  'research',
  'documentation',
  'support',
  'training',
  'admin',
  'other',
] as const;
export type TimesheetCategory = (typeof TIMESHEET_CATEGORIES)[number];

// ─── Entries ─────────────────────────────────────────────────────────────────

export class TimesheetEntryDto {
  @ApiProperty({ example: '2026-05-08' })
  @IsString()
  @IsNotEmpty()
  entryDate: string;

  @ApiProperty({ example: 4.5, description: '0.25 hour increments' })
  @IsNumber()
  @Min(0)
  @Max(24)
  @Type(() => Number)
  hours: number;

  @ApiProperty({ enum: TIMESHEET_CATEGORIES })
  @IsIn(TIMESHEET_CATEGORIES as unknown as string[])
  category: TimesheetCategory;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isBillable?: boolean = false;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  projectId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  taskId?: string;
}

export class BulkSaveEntriesDto {
  @ApiProperty()
  @IsUUID()
  timesheetPeriodId: string;

  @ApiProperty({ type: [TimesheetEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(31)
  @ValidateNested({ each: true })
  @Type(() => TimesheetEntryDto)
  entries: TimesheetEntryDto[];
}

export class SubmitTimesheetDto {
  @ApiProperty()
  @IsUUID()
  timesheetPeriodId: string;
}

export class ReviewTimesheetDto {
  @ApiProperty({ enum: ['approve', 'reject', 'rework'] })
  @IsIn(['approve', 'reject', 'rework'])
  action: 'approve' | 'reject' | 'rework';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  comment?: string;
}

// ─── Listing ─────────────────────────────────────────────────────────────────

export class TimesheetListQueryDto {
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
