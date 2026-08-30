import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Auditor invite + grant DTOs (PRD §3, §4.4). Grants drive both the
 * InvoicingGrantGuard and the auditor's sidebar; the capabilities object holds
 * the fine-grained switches from the Invite-auditor modal (send,
 * record_payment, manage_customers).
 */

export const GRANT_MODULES = [
  'invoicing',
  'reports',
  'org_financial',
  'payroll',
  'expenses',
  // Round 8 — CRM and Projects are administered from Settings → Module access.
  // They were missing here, so the endpoint 400'd on either.
  'crm',
  'pm',
] as const;

/**
 * The modules an Owner administers from Settings → Module access. The rest of
 * GRANT_MODULES stay auditor-scope concerns on the Invite-auditor modal.
 */
export const MANAGED_MODULES = ['crm', 'invoicing', 'pm'] as const;

/**
 * Roles a workspace policy may set. The full-access roles (owner/admin, plus
 * finance for invoicing) are deliberately absent: they hold their modules by
 * role and a row for them would be dead data — or, worse, read as a promise
 * the guard does not keep.
 */
export const POLICY_ROLES = ['manager', 'employee', 'finance', 'auditor'] as const;

export const GRANT_LEVELS = ['none', 'view', 'edit'] as const;

export class GrantInputDto {
  @IsIn(GRANT_MODULES as unknown as string[])
  module!: string;

  @IsIn(GRANT_LEVELS as unknown as string[])
  access_level!: string;

  @ApiPropertyOptional({
    description: 'Capability switches, e.g. { send, record_payment, manage_customers }',
  })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, boolean>;
}

export class InviteAuditorDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  full_name?: string;

  @ApiPropertyOptional({
    description:
      'Module grants. Omitted → review-grade defaults (invoicing:view, reports:view, org_financial:view).',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GrantInputDto)
  grants?: GrantInputDto[];

  @ApiPropertyOptional({ description: 'Optional engagement end date (YYYY-MM-DD)' })
  @IsOptional()
  @IsString()
  access_expires_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @ApiPropertyOptional({ description: 'External CA firm vs internal reviewer', default: true })
  @IsOptional()
  @IsBoolean()
  is_external?: boolean;
}

/**
 * Single-module write. Preferred over UpdateGrantsDto for any partial UI: the
 * replace-all endpoint deletes every row it is not told about, so a screen
 * that knows about three modules silently revokes the rest.
 */
export class UpsertGrantDto {
  @IsIn(GRANT_LEVELS as unknown as string[])
  access_level!: string;

  @ApiPropertyOptional({
    description: 'Capability switches, e.g. { send, record_payment, manage_customers }',
  })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, boolean>;
}

export class RoleDefaultInputDto {
  @IsIn(POLICY_ROLES as unknown as string[])
  role!: string;

  @IsIn(MANAGED_MODULES as unknown as string[])
  module!: string;

  @IsIn(GRANT_LEVELS as unknown as string[])
  access_level!: string;
}

export class UpdateRoleDefaultsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleDefaultInputDto)
  defaults!: RoleDefaultInputDto[];
}

export class UpdateGrantsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GrantInputDto)
  grants!: GrantInputDto[];
}
