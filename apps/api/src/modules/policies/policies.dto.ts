import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  POLICY_KINDS,
  POLICY_TARGET_ROLES,
  type PolicyKind,
  type PolicyTargetRole,
} from '@flicks/db/schema';

/** Hard cap on a rich-text body — enforced here AND by cleanMarkdown (400, never a silent cut). */
export const POLICY_BODY_MAX_LEN = 100_000;
export const POLICY_TITLE_MAX_LEN = 200;
export const POLICY_CATEGORY_MAX_LEN = 60;

/**
 * Company-policy DTOs (Round P R3). Every field runs through the global
 * ValidationPipe (whitelist + forbidNonWhitelisted): unknown keys, a bad
 * `kind`, a role outside the standard five or an over-long title are 400s
 * before the service sees them. `applies_to_roles` null (or []) means every
 * standard role; guest/auditor can never be targeted.
 */
export class CreatePolicyDto {
  @ApiProperty({ maxLength: POLICY_TITLE_MAX_LEN })
  @IsString()
  @MinLength(1)
  @MaxLength(POLICY_TITLE_MAX_LEN)
  title!: string;

  @ApiProperty({ enum: POLICY_KINDS })
  @IsIn(POLICY_KINDS as unknown as string[])
  kind!: PolicyKind;

  @ApiPropertyOptional({ description: 'Markdown body (rich-text policies); cleaned server-side' })
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_BODY_MAX_LEN)
  body_md?: string | null;

  @ApiPropertyOptional({ maxLength: POLICY_CATEGORY_MAX_LEN })
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_CATEGORY_MAX_LEN)
  category?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  requires_acknowledgement?: boolean;

  @ApiPropertyOptional({
    enum: POLICY_TARGET_ROLES,
    isArray: true,
    description: 'Omitted / null / [] = every standard role',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POLICY_TARGET_ROLES.length)
  @IsIn(POLICY_TARGET_ROLES as unknown as string[], { each: true })
  applies_to_roles?: PolicyTargetRole[] | null;
}

export class UpdatePolicyDto {
  @ApiPropertyOptional({ maxLength: POLICY_TITLE_MAX_LEN })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(POLICY_TITLE_MAX_LEN)
  title?: string;

  @ApiPropertyOptional({ enum: POLICY_KINDS })
  @IsOptional()
  @IsIn(POLICY_KINDS as unknown as string[])
  kind?: PolicyKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_BODY_MAX_LEN)
  body_md?: string | null;

  @ApiPropertyOptional({ maxLength: POLICY_CATEGORY_MAX_LEN })
  @IsOptional()
  @IsString()
  @MaxLength(POLICY_CATEGORY_MAX_LEN)
  category?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requires_acknowledgement?: boolean;

  @ApiPropertyOptional({ enum: POLICY_TARGET_ROLES, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(POLICY_TARGET_ROLES.length)
  @IsIn(POLICY_TARGET_ROLES as unknown as string[], { each: true })
  applies_to_roles?: PolicyTargetRole[] | null;
}

export class PublishPolicyDto {
  @ApiPropertyOptional({
    description:
      'When the policy is already published: bump the version so everyone must agree again. Ignored on a first publish.',
  })
  @IsOptional()
  @IsBoolean()
  require_reacknowledgement?: boolean;
}

export class AcknowledgePolicyDto {
  @ApiProperty({ description: 'The version the member read — must equal the current one (else 409 POLICY_VERSION_STALE)' })
  @IsInt()
  @Min(1)
  version!: number;
}
