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
 * record_payments, manage_customers).
 */

export const GRANT_MODULES = [
  'invoicing',
  'reports',
  'org_financial',
  'payroll',
  'expenses',
] as const;

export const GRANT_LEVELS = ['none', 'view', 'edit'] as const;

export class GrantInputDto {
  @IsIn(GRANT_MODULES as unknown as string[])
  module!: string;

  @IsIn(GRANT_LEVELS as unknown as string[])
  access_level!: string;

  @ApiPropertyOptional({
    description: 'Capability switches, e.g. { send, record_payments, manage_customers }',
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

export class UpdateGrantsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GrantInputDto)
  grants!: GrantInputDto[];
}
