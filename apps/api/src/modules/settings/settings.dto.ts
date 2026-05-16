import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUUID,
  IsArray,
  IsEnum,
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

export class UpdateDesignationDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

// ─── Shift templates (working hours) ─────────────────────────────────────────

export class CreateShiftTemplateDto {
  @ApiProperty({ example: 'General' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ example: '09:00' })
  @Matches(TIME_HHMM, { message: 'startTime must be HH:MM (24h)' })
  startTime: string;

  @ApiProperty({ example: '18:00' })
  @Matches(TIME_HHMM, { message: 'endTime must be HH:MM (24h)' })
  endTime: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isOvernight?: boolean;

  @ApiPropertyOptional({ default: 60 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(240)
  @Type(() => Number)
  breakMinutes?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  breakPaid?: boolean;

  @ApiProperty({
    description: 'Working days as 0–6 ints (0=Sun..6=Sat)',
    example: [1, 2, 3, 4, 5],
    isArray: true,
  })
  @IsArray()
  @IsNumber({}, { each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  workingDays: number[];

  @ApiPropertyOptional({ default: 'Asia/Kolkata' })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ default: 15 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(120)
  @Type(() => Number)
  gracePeriodMinutes?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateShiftTemplateDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM)
  startTime?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Matches(TIME_HHMM)
  endTime?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isOvernight?: boolean;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(240)
  @Type(() => Number)
  breakMinutes?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  breakPaid?: boolean;

  @ApiPropertyOptional({ isArray: true })
  @IsArray()
  @IsOptional()
  @IsNumber({}, { each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  workingDays?: number[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(120)
  @Type(() => Number)
  gracePeriodMinutes?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

// ─── Leave policies ──────────────────────────────────────────────────────────

const LEAVE_ACCRUAL_VALUES = [
  'none',
  'monthly',
  'quarterly',
  'annually',
  'per_working_day',
] as const;

export class CreateLeavePolicyDto {
  @ApiProperty({ example: 'Casual Leave' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'CL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  @Matches(/^[A-Z0-9]+$/, { message: 'Code must be uppercase letters and digits' })
  code: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(400)
  description?: string;

  @ApiProperty({ example: 12 })
  @IsNumber()
  @Min(0)
  @Max(365)
  @Type(() => Number)
  defaultQuotaDays: number;

  @ApiPropertyOptional({ default: 'none', enum: LEAVE_ACCRUAL_VALUES })
  @IsString()
  @IsOptional()
  @IsEnum(LEAVE_ACCRUAL_VALUES)
  accrualMethod?: (typeof LEAVE_ACCRUAL_VALUES)[number];

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  carryForwardAllowed?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(365)
  @Type(() => Number)
  maxCarryForwardDays?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  encashable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isLop?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  allowHalfDay?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(60)
  @Type(() => Number)
  minNoticeDays?: number;

  @ApiPropertyOptional({ example: '#3E7BFA' })
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Color must be a 6-digit hex like #3E7BFA' })
  color?: string;
}

export class UpdateLeavePolicyDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(400)
  description?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(365)
  @Type(() => Number)
  defaultQuotaDays?: number;

  @ApiPropertyOptional({ enum: LEAVE_ACCRUAL_VALUES })
  @IsString()
  @IsOptional()
  @IsEnum(LEAVE_ACCRUAL_VALUES)
  accrualMethod?: (typeof LEAVE_ACCRUAL_VALUES)[number];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  carryForwardAllowed?: boolean;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(365)
  @Type(() => Number)
  maxCarryForwardDays?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  encashable?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isPaid?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  allowHalfDay?: boolean;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(60)
  @Type(() => Number)
  minNoticeDays?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/)
  color?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

// ─── Members (memberships / workspace access) ────────────────────────────────

const MEMBER_ROLE_VALUES = [
  'fam',
  'super_admin',
  'owner',
  'admin',
  'manager',
  'finance',
  'employee',
] as const;

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: MEMBER_ROLE_VALUES })
  @IsString()
  @IsEnum(MEMBER_ROLE_VALUES)
  role: (typeof MEMBER_ROLE_VALUES)[number];
}

// ─── Organization (tenant profile) ───────────────────────────────────────────

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'Acme Inc' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Acme Corporation Pvt Ltd' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({ example: '27AABCU9603R1ZX' })
  @IsString()
  @IsOptional()
  @Matches(GSTIN_RE, { message: 'Invalid GSTIN format' })
  gstin?: string;

  @ApiPropertyOptional({ example: 'AABCU9603R' })
  @IsString()
  @IsOptional()
  @Matches(PAN_RE, { message: 'Invalid PAN format' })
  pan?: string;

  @ApiPropertyOptional({ example: 'U72200KA2020PTC123456' })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  cin?: string;

  @ApiPropertyOptional({ example: 'Technology' })
  @IsString()
  @IsOptional()
  @MaxLength(80)
  industry?: string;

  @ApiPropertyOptional({ example: '11-50' })
  @IsString()
  @IsOptional()
  @MaxLength(20)
  sizeBand?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({ example: 'Bengaluru' })
  @IsString()
  @IsOptional()
  @MaxLength(80)
  city?: string;

  @ApiPropertyOptional({ example: 'KA' })
  @IsString()
  @IsOptional()
  @MaxLength(2)
  stateCode?: string;

  @ApiPropertyOptional({ example: '560038' })
  @IsString()
  @IsOptional()
  @MaxLength(12)
  postalCode?: string;
}
