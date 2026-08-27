import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsUUID,
  IsArray,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// FAM = Fleet Administration & Monitoring (platform-admin tooling)

export const HEALTH_SIGNALS = [
  'healthy',
  'at_risk',
  'churning',
  'expanding',
  'new',
] as const;
export type HealthSignal = (typeof HEALTH_SIGNALS)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'paused',
  'unpaid',
] as const;

// ─── Tenant lifecycle ─────────────────────────────────────────────────────────

export class SuspendTenantDto {
  @ApiProperty({ example: 'Payment failed for 3 cycles' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class ExtendTrialDto {
  @ApiProperty({ example: 14, description: 'Number of additional days' })
  @IsNumber()
  @Min(1)
  @Max(180)
  @Type(() => Number)
  days: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}

// ─── Impersonation ────────────────────────────────────────────────────────────

export class StartImpersonationDto {
  // membershipId is now the canonical input — the FAM tenant detail page
  // always has a real membership row to point at. targetUserId is kept as
  // a backwards-compat alternative; one of the two must be provided.
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  membershipId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  targetUserId?: string;

  @ApiProperty({ example: 'Investigating reported attendance bug' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

// ─── Feature flags ────────────────────────────────────────────────────────────

export class UpsertFeatureFlagDto {
  @ApiProperty({ example: 'beta.timesheets_v2' })
  @IsString()
  @IsNotEmpty()
  flagKey: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isEnabledGlobally?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  enabledTenantIds?: string[];

  @ApiPropertyOptional({ default: 0 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  rolloutPercentage?: number;
}

// ─── Cohorts ──────────────────────────────────────────────────────────────────

export class UpsertCohortDto {
  @ApiProperty({ example: 'Healthcare-50-200' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  tenantIds: string[];
}

// ─── Listings ─────────────────────────────────────────────────────────────────

export class TenantListQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ enum: HEALTH_SIGNALS })
  @IsIn(HEALTH_SIGNALS as unknown as string[])
  @IsOptional()
  signal?: HealthSignal;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;

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

export class ToggleModuleDto {
  @ApiProperty({ description: 'Enable or disable the module for this tenant' })
  @IsBoolean()
  enabled!: boolean;
}

export class VerifyTenantDto {
  @ApiPropertyOptional({ description: 'Reviewer notes stored in the platform audit log' })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}
