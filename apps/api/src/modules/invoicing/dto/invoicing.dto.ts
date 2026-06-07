import {
  IsString,
  IsOptional,
  IsInt,
  IsEmail,
  IsArray,
  IsBoolean,
  IsNumberString,
  IsIn,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Invoicing DTOs. Validation shapes for the resources implemented in Sprint 2
 * (customers, items, HSN/SAC, numbering). Invoice-level DTOs stay minimal until
 * Sprint 3.
 */

export class ListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Free-text search' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'Status filter (e.g. active | archived)' })
  @IsOptional()
  @IsString()
  status?: string;
}

// ─── Customers ──────────────────────────────────────────────────────────────

export class CreateCustomerDto {
  @IsString()
  @MaxLength(120)
  display_name!: string;

  @IsOptional() @IsString() customer_code?: string;
  @IsOptional() @IsString() legal_name?: string;
  @IsOptional() @IsIn(['business', 'individual']) customer_type?: string;
  @IsOptional() @IsString() primary_contact_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) secondary_emails?: string[];
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() country_code?: string;
  @IsOptional() @IsString() state_code?: string;
  @IsOptional() @IsString() billing_address_line1?: string;
  @IsOptional() @IsString() billing_address_line2?: string;
  @IsOptional() @IsString() billing_city?: string;
  @IsOptional() @IsString() billing_state?: string;
  @IsOptional() @IsString() billing_postal_code?: string;
  @IsOptional() @IsString() billing_country?: string;
  @IsOptional() @IsBoolean() shipping_same_as_billing?: boolean;
  @IsOptional() @IsBoolean() is_gst_registered?: boolean;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() pan?: string;
  @IsOptional() @IsString() intl_tax_id?: string;
  @IsOptional() @IsString() default_currency?: string;
  @IsOptional() @Type(() => Number) @IsInt() default_payment_terms_days?: number;
  @IsOptional() @IsString() default_notes?: string;
  @IsOptional() @IsString() internal_notes?: string;
}

export class UpdateCustomerDto extends CreateCustomerDto {
  @IsOptional()
  @IsString()
  declare display_name: string;
}

export class ImportCustomersDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCustomerDto)
  rows!: CreateCustomerDto[];
}

// ─── Items ──────────────────────────────────────────────────────────────────

export class CreateItemDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsNumberString()
  default_rate!: string;

  @IsOptional() @IsString() item_code?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() hsn_sac_code?: string;
  @IsOptional() @IsNumberString() default_gst_rate?: string;
  @IsOptional() @IsNumberString() cess_rate?: string;
  @IsOptional() @IsBoolean() tax_exempt?: boolean;
}

export class UpdateItemDto extends CreateItemDto {
  @IsOptional()
  @IsString()
  declare name: string;

  @IsOptional()
  @IsNumberString()
  declare default_rate: string;
}

export class ImportItemsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateItemDto)
  rows!: CreateItemDto[];
}

// ─── HSN/SAC ────────────────────────────────────────────────────────────────

export class HsnSacSearchDto {
  @IsString()
  @MaxLength(120)
  q!: string;

  @ApiPropertyOptional({ enum: ['HSN', 'SAC'] })
  @IsOptional()
  @IsIn(['HSN', 'SAC'])
  type?: string;
}

export class AddCustomHsnDto {
  @IsString() code!: string;
  @IsIn(['HSN', 'SAC']) type!: string;
  @IsString() description!: string;
  @IsOptional() @IsNumberString() default_gst_rate?: string;
  @IsOptional() @IsString() category?: string;
}

// ─── Numbering (invoice_sequences) ──────────────────────────────────────────

export class UpsertSequenceDto {
  @IsIn(['INVOICE', 'QUOTE', 'CREDIT_NOTE', 'DEBIT_NOTE'])
  document_type!: string;

  @IsOptional() @IsString() @MaxLength(10) prefix?: string;
  @IsOptional() @IsString() @MaxLength(3) separator?: string;
  @IsOptional() @IsString() fy_format?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) zero_padding?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) starting_number?: number;
  @IsOptional() @IsString() @MaxLength(10) branch_code?: string;
  @IsOptional() @IsString() fy_label?: string;
}

export class PreviewNumberDto {
  @IsIn(['INVOICE', 'QUOTE', 'CREDIT_NOTE', 'DEBIT_NOTE'])
  document_type!: string;

  @IsOptional() @IsString() prefix?: string;
  @IsOptional() @IsString() separator?: string;
  @IsOptional() @IsString() fy_format?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10) zero_padding?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) starting_number?: number;
  @IsOptional() @IsString() branch_code?: string;
  @IsOptional() @IsString() fy_label?: string;
  @IsOptional() @IsString() on_date?: string;
}

export class CreateInvoiceDto {
  @IsString() customer_id!: string;
  @IsString() invoice_date!: string;
  @IsString() due_date!: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsArray() line_items?: unknown[];
}
