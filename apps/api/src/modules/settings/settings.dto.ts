import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUUID,
  IsArray,
  Matches,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TIME_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ─── Departments ─────────────────────────────────────────────────────────────

export class CreateDepartmentDto {
  @ApiProperty({ example: 'Engineering' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'ENG' })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  code?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  parentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  headEmployeeId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;
}

export class UpdateDepartmentDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  headEmployeeId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

// ─── Locations ───────────────────────────────────────────────────────────────

export class CreateLocationDto {
  @ApiProperty({ example: 'Bangalore HQ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  addressLine1?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  addressLine2?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  stateCode?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  postalCode?: string;

  @ApiPropertyOptional({ default: 'IN' })
  @IsString()
  @IsOptional()
  countryCode?: string;

  @ApiPropertyOptional({ default: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  geofenceLat?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  geofenceLng?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Type(() => Number)
  geofenceRadiusM?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ipAllowlist?: string[];
}

export class UpdateLocationDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  addressLine1?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  postalCode?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

// ─── Working hours / tenant defaults ─────────────────────────────────────────

export const WORKING_DAY_VALUES = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
] as const;
export type WorkingDay = (typeof WORKING_DAY_VALUES)[number];

export class UpdateWorkingHoursDto {
  @ApiProperty({
    example: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
    enum: WORKING_DAY_VALUES,
    isArray: true,
  })
  @IsArray()
  @IsString({ each: true })
  workingDays: WorkingDay[];

  @ApiProperty({ example: '09:00' })
  @Matches(TIME_HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime: string;

  @ApiProperty({ example: '18:00' })
  @Matches(TIME_HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime: string;

  @ApiPropertyOptional({ default: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;
}

// ─── Designations ────────────────────────────────────────────────────────────

export class CreateDesignationDto {
  @ApiProperty({ example: 'Senior Software Engineer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @ApiPropertyOptional({ example: 5 })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(20)
  @Type(() => Number)
  level?: number;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;
}
