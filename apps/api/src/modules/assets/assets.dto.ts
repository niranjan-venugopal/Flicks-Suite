import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ASSET_CATEGORIES,
  ASSET_CONDITIONS,
  ASSET_STATUSES,
  type AssetCategory,
  type AssetCondition,
  type AssetStatus,
} from '@flicks/db/schema';

/**
 * Company asset register DTOs (Round P R4). Every field runs through the
 * global ValidationPipe (whitelist + forbidNonWhitelisted + implicit
 * conversion), so an unknown key, a bad category/condition, a negative value
 * or an over-long tag is a 400 before the service sees it. No nested objects
 * here, so the `@Type(() => Object)` gotcha (house rule 5) does not apply.
 */

export const ASSET_TAG_MAX_LEN = 32;
export const ASSET_TAG_RE = /^[A-Za-z0-9._/-]+$/;
export const ASSET_NAME_MAX_LEN = 120;
export const ASSET_TEXT_MAX_LEN = 120;
export const ASSET_NOTES_MAX_LEN = 2000;
export const ASSET_Q_MAX_LEN = 120;
export const ASSET_LIST_DEFAULT_LIMIT = 100;
export const ASSET_LIST_MAX_LIMIT = 200;

/** `assigned` is never set by hand — it follows the open assignment row. */
export const ASSET_EDITABLE_STATUSES = ['in_stock', 'under_repair', 'retired', 'lost'] as const;
export type AssetEditableStatus = (typeof ASSET_EDITABLE_STATUSES)[number];

const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;
/** Up to 13 integer digits (numeric(15,2)) and at most two decimals; never negative. */
const AMOUNT_RE = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * `null` reads as "not provided". class-validator's @IsOptional skips the
 * validators for null as well as undefined, so without this a NOT NULL field
 * (name, category, currency, condition, status, asset_tag) could reach the
 * service as null — a TypeError / NOT NULL violation, i.e. a 500.
 */
const nullToUndefined = ({ value }: { value: unknown }) => (value === null ? undefined : value);

/** Trim; a blank string (or null) reads as "not provided" (the server picks the next tag / keeps the current one). */
const blankToUndefined = ({ value }: { value: unknown }) =>
  value === null ? undefined : typeof value === 'string' ? value.trim() || undefined : value;

/** Trim; a blank string clears the column (null). */
const blankToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** Numbers become a 2-dp string, strings are trimmed; validation then runs on the string. */
const normaliseAmount = ({ value }: { value: unknown }) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : 'NaN';
  if (typeof value === 'string') return value.trim() || null;
  return String(value);
};

const upperTrim = ({ value }: { value: unknown }) =>
  value === null ? undefined : typeof value === 'string' ? value.trim().toUpperCase() || undefined : value;

export class CreateAssetDto {
  @ApiPropertyOptional({
    maxLength: ASSET_TAG_MAX_LEN,
    description: 'Letters, digits, . _ / - ; blank or absent → the server uses the next free AST-NNNN',
  })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ASSET_TAG_MAX_LEN)
  @Matches(ASSET_TAG_RE, { message: 'asset_tag may only contain letters, digits, dots, underscores, slashes and dashes' })
  asset_tag?: string;

  @ApiProperty({ maxLength: ASSET_NAME_MAX_LEN })
  @IsString()
  @MinLength(1)
  @MaxLength(ASSET_NAME_MAX_LEN)
  name!: string;

  @ApiProperty({ enum: ASSET_CATEGORIES })
  @IsIn(ASSET_CATEGORIES as unknown as string[])
  category!: AssetCategory;

  @ApiPropertyOptional({ maxLength: ASSET_TEXT_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_TEXT_MAX_LEN)
  brand?: string | null;

  @ApiPropertyOptional({ maxLength: ASSET_TEXT_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_TEXT_MAX_LEN)
  model?: string | null;

  @ApiPropertyOptional({ maxLength: ASSET_TEXT_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_TEXT_MAX_LEN)
  serial_number?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @Transform(blankToNull)
  @IsOptional()
  @Matches(DATE_YMD, { message: 'purchase_date must be YYYY-MM-DD' })
  purchase_date?: string | null;

  @ApiPropertyOptional({ description: 'Non-negative amount, up to 2 decimals (string or number)' })
  @Transform(normaliseAmount)
  @IsOptional()
  @Matches(AMOUNT_RE, { message: 'purchase_value must be a non-negative amount with up to 2 decimals' })
  purchase_value?: string | number | null;

  @ApiPropertyOptional({ default: 'INR', description: '3-letter ISO code' })
  @Transform(upperTrim)
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ enum: ASSET_CONDITIONS, default: 'good' })
  @IsOptional()
  @IsIn(ASSET_CONDITIONS as unknown as string[])
  condition?: AssetCondition;

  @ApiPropertyOptional({ maxLength: ASSET_NOTES_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_NOTES_MAX_LEN)
  notes?: string | null;
}

export class UpdateAssetDto {
  @ApiPropertyOptional({ maxLength: ASSET_TAG_MAX_LEN })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ASSET_TAG_MAX_LEN)
  @Matches(ASSET_TAG_RE, { message: 'asset_tag may only contain letters, digits, dots, underscores, slashes and dashes' })
  asset_tag?: string;

  @ApiPropertyOptional({ maxLength: ASSET_NAME_MAX_LEN })
  @Transform(nullToUndefined)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ASSET_NAME_MAX_LEN)
  name?: string;

  @ApiPropertyOptional({ enum: ASSET_CATEGORIES })
  @Transform(nullToUndefined)
  @IsOptional()
  @IsIn(ASSET_CATEGORIES as unknown as string[])
  category?: AssetCategory;

  @ApiPropertyOptional({ maxLength: ASSET_TEXT_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_TEXT_MAX_LEN)
  brand?: string | null;

  @ApiPropertyOptional({ maxLength: ASSET_TEXT_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_TEXT_MAX_LEN)
  model?: string | null;

  @ApiPropertyOptional({ maxLength: ASSET_TEXT_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_TEXT_MAX_LEN)
  serial_number?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @Transform(blankToNull)
  @IsOptional()
  @Matches(DATE_YMD, { message: 'purchase_date must be YYYY-MM-DD' })
  purchase_date?: string | null;

  @ApiPropertyOptional({ description: 'Non-negative amount, up to 2 decimals (string or number)' })
  @Transform(normaliseAmount)
  @IsOptional()
  @Matches(AMOUNT_RE, { message: 'purchase_value must be a non-negative amount with up to 2 decimals' })
  purchase_value?: string | number | null;

  @ApiPropertyOptional({ description: '3-letter ISO code' })
  @Transform(upperTrim)
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter code' })
  currency?: string;

  @ApiPropertyOptional({ enum: ASSET_CONDITIONS })
  @Transform(nullToUndefined)
  @IsOptional()
  @IsIn(ASSET_CONDITIONS as unknown as string[])
  condition?: AssetCondition;

  @ApiPropertyOptional({
    enum: ASSET_EDITABLE_STATUSES,
    description: 'Only while nobody holds the asset (else 409 ASSET_ASSIGNED); `assigned` follows the assignment row',
  })
  @Transform(nullToUndefined)
  @IsOptional()
  @IsIn(ASSET_EDITABLE_STATUSES as unknown as string[])
  status?: AssetEditableStatus;

  @ApiPropertyOptional({ maxLength: ASSET_NOTES_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_NOTES_MAX_LEN)
  notes?: string | null;
}

export class AssignAssetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  employee_id!: string;

  @ApiPropertyOptional({ description: 'ISO date-time; defaults to now. Not more than a day in the future.' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsISO8601({ strict: true })
  assigned_at?: string;

  @ApiPropertyOptional({ enum: ASSET_CONDITIONS, description: 'Defaults to the asset’s current condition' })
  @IsOptional()
  @IsIn(ASSET_CONDITIONS as unknown as string[])
  issue_condition?: AssetCondition;

  @ApiPropertyOptional({ maxLength: ASSET_NOTES_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_NOTES_MAX_LEN)
  notes?: string | null;
}

export class ReturnAssetDto {
  @ApiProperty({ enum: ASSET_CONDITIONS })
  @IsIn(ASSET_CONDITIONS as unknown as string[])
  return_condition!: AssetCondition;

  @ApiPropertyOptional({ maxLength: ASSET_NOTES_MAX_LEN })
  @Transform(blankToNull)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_NOTES_MAX_LEN)
  return_notes?: string | null;

  @ApiPropertyOptional({ enum: ASSET_EDITABLE_STATUSES, default: 'in_stock' })
  @IsOptional()
  @IsIn(ASSET_EDITABLE_STATUSES as unknown as string[])
  next_status?: AssetEditableStatus;
}

export class ListAssetsQueryDto {
  @ApiPropertyOptional({ enum: ASSET_STATUSES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(ASSET_STATUSES as unknown as string[])
  status?: AssetStatus;

  @ApiPropertyOptional({ enum: ASSET_CATEGORIES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(ASSET_CATEGORIES as unknown as string[])
  category?: AssetCategory;

  @ApiPropertyOptional({ format: 'uuid', description: 'Assets currently held by this employee' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsUUID()
  employee_id?: string;

  @ApiPropertyOptional({ maxLength: ASSET_Q_MAX_LEN, description: 'Matches tag / name / serial / brand / model' })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsString()
  @MaxLength(ASSET_Q_MAX_LEN)
  q?: string;

  @ApiPropertyOptional({ default: ASSET_LIST_DEFAULT_LIMIT, maximum: ASSET_LIST_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ASSET_LIST_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
