import {
  IsString,
  IsNotEmpty,
  IsOptional,
  Matches,
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

/**
 * Round L: an instant WITH a zone designator — `2026-05-08T09:00:00Z` or
 * `…+05:30`. Offset-less strings (`2026-05-08T09:00:00`, `2026-05-08`) are
 * refused: `new Date()` would read them in the server's zone, not the
 * shift's. (`IsISO8601` admits them.)
 */
export const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export class RegularizationRequestDto {
  // Round L: a calendar day, nothing else — the service compares it against
  // "today" in the shift's timezone and every instant below must fall on it.
  @ApiProperty({ example: '2026-05-08' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'attendanceDate must be YYYY-MM-DD',
  })
  attendanceDate: string;

  @ApiProperty({ enum: REGULARIZATION_TYPES })
  @IsIn(REGULARIZATION_TYPES as unknown as string[])
  requestType: RegularizationType;

  @ApiPropertyOptional({ example: '2026-05-08T09:00:00Z' })
  @IsOptional()
  @IsString()
  @Matches(ISO_INSTANT_RE, {
    message: 'proposedInTime must be an ISO-8601 instant with a zone (e.g. 2026-05-08T09:00:00Z)',
  })
  proposedInTime?: string;

  @ApiPropertyOptional({ example: '2026-05-08T18:00:00Z' })
  @IsOptional()
  @IsString()
  @Matches(ISO_INSTANT_RE, {
    message: 'proposedOutTime must be an ISO-8601 instant with a zone (e.g. 2026-05-08T18:00:00Z)',
  })
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

export class AttendanceMonthQueryDto {
  @ApiProperty({ example: '2026-07' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;
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
