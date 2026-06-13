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

// ─── Invoices (Sprint 3) ────────────────────────────────────────────────────

export class InvoiceLineDto {
  @IsOptional() @IsString() item_id?: string;
  @IsString() @MaxLength(200) item_name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() hsn_sac_code?: string;
  @IsNumberString() quantity!: string;
  @IsOptional() @IsString() unit?: string;
  @IsNumberString() rate!: string;
  @IsOptional() @IsNumberString() gst_rate?: string;
  @IsOptional() @IsNumberString() cess_rate?: string;
}

export class CreateInvoiceDto {
  @IsString() customer_id!: string;
  @IsString() invoice_date!: string; // YYYY-MM-DD
  @IsString() due_date!: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() place_of_supply?: string;
  @IsOptional()
  @IsIn(['INTRA_STATE', 'INTER_STATE', 'EXPORT', 'B2C_LARGE', 'B2C_SMALL'])
  tax_treatment?: string;
  @IsOptional() @IsIn(['percent', 'fixed']) discount_type?: string;
  @IsOptional() @IsNumberString() discount_value?: string;
  @IsOptional() @IsString() tds_section?: string;
  @IsOptional() @IsString() tds_payment_code?: string;
  @IsOptional() @IsNumberString() tds_rate?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms_and_conditions?: string;
  @IsOptional() @IsString() bank_account_id?: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  line_items!: InvoiceLineDto[];
}

export class UpdateInvoiceDto extends CreateInvoiceDto {
  @IsOptional() @IsString() declare customer_id: string;
  @IsOptional() @IsString() declare invoice_date: string;
  @IsOptional() @IsString() declare due_date: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineDto)
  declare line_items: InvoiceLineDto[];
}

export class InvoiceListQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Filter by customer' })
  @IsOptional()
  @IsString()
  customer_id?: string;
}

export class RecordPaymentDto {
  @IsNumberString() amount!: string;
  @IsOptional() @IsString() payment_date?: string; // YYYY-MM-DD, default today
  @IsIn([
    'CASH',
    'BANK_TRANSFER',
    'CHEQUE',
    'UPI_DIRECT',
    'RAZORPAY_UPI',
    'RAZORPAY_CARD',
    'RAZORPAY_NETBANKING',
    'RAZORPAY_WALLET',
    'OTHER',
  ])
  payment_method!: string;
  @IsOptional() @IsString() reference_number?: string;
  @IsOptional() @IsString() razorpay_payment_id?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CancelInvoiceDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class WriteOffInvoiceDto {
  @IsString() @MaxLength(500) reason!: string;
}

// ─── Notes / adjustments / reports (Sprint 6) ───────────────────────────────

export class CreateNoteDto {
  @IsOptional() @IsString() invoice_id?: string;
  @IsOptional() @IsString() customer_id?: string;
  @IsString() reason!: string;
  @IsOptional() @IsString() @MaxLength(500) reason_description?: string;
  @IsNumberString() amount!: string;
}

export class CreateAdjustmentDto {
  @IsString() customer_id!: string;
  @IsOptional() @IsString() adjustment_date?: string;
  @IsNumberString() amount!: string; // + customer owes more / − owes less
  @IsOptional() @IsString() currency?: string;
  @IsIn(['opening_balance', 'write_off', 'round_off', 'bank_charge', 'other'])
  type!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class GenerateGstr1Dto {
  @Type(() => Number) @IsInt() @Min(1) @Max(12) period_month!: number;
  @Type(() => Number) @IsInt() @Min(2020) @Max(2100) period_year!: number;
  @IsOptional() @IsIn(['json', 'csv']) format?: string;
}

// ─── Subscriptions (Sprint 7) ───────────────────────────────────────────────

export class CreateSubscriptionDto {
  @IsString() customer_id!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsIn(['flat_rate', 'per_seat']) pricing_model!: string;
  @IsOptional() @IsString() currency?: string; // LOCKED at creation
  @IsOptional() @IsNumberString() flat_amount?: string;
  @IsOptional() @IsNumberString() seat_rate?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) seat_count?: number;
  @IsIn(['monthly', 'quarterly', 'annually', 'custom']) billing_period!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) custom_period_days?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(28) anchor_day?: number;
  @IsString() start_date!: string; // YYYY-MM-DD
  @IsOptional() @IsIn(['until_cancelled', 'after_n_cycles', 'on_date']) end_condition?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) end_after_cycles?: number;
  @IsOptional() @IsString() end_date?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) trial_days?: number;
}

export class UpdateSeatsDto {
  @Type(() => Number) @IsInt() @Min(1) seat_count!: number;
}

export class CancelSubscriptionDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

// ─── Invoicing settings + setup wizard (Sprint 9 — PRD §7.1, §11) ────────────

export class UpdateInvSettingsDto {
  @IsOptional() @IsString() default_currency?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) default_payment_terms_days?: number;
  @IsOptional() @IsNumberString() default_gst_rate?: string;
  @IsOptional() @IsString() default_invoice_notes?: string;
  @IsOptional() @IsString() default_terms_and_conditions?: string;
  @IsOptional() @IsString() invoice_template?: string;
  @IsOptional() @IsString() brand_color_override?: string;
  @IsOptional() @IsBoolean() show_gstin_on_pdf?: boolean;
  @IsOptional() @IsBoolean() show_tds_section_on_pdf?: boolean;
  @IsOptional() @IsBoolean() show_upi_qr_on_pdf?: boolean;
  @IsOptional() @IsBoolean() show_powered_by_footer?: boolean;
  @IsOptional() @IsString() email_sender_name?: string;
  @IsOptional() @IsString() email_reply_to?: string;
  @IsOptional() @IsString() email_signature?: string;
  @IsOptional() @IsBoolean() cc_owner_on_customer_emails?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) additional_cc_emails?: string[];
  @IsOptional() @IsString() upi_id?: string;
  @IsOptional() @IsString() upi_display_name?: string;
  @IsOptional() @IsBoolean() allow_partial_payments?: boolean;
  @IsOptional() @IsIn(['monthly', 'quarterly']) filing_frequency?: string;
  @IsOptional() @IsNumberString() declared_aato?: string;
  @IsOptional() @IsBoolean() composition_scheme?: boolean;
  @IsOptional() @IsString() default_tds_section?: string;
  @IsOptional() @IsString() default_tds_payment_code?: string;
  @IsOptional() @IsNumberString() default_tds_rate?: string;
  @IsOptional() @IsBoolean() auto_suggest_tds?: boolean;
}

export class UpdateSetupProgressDto {
  @IsOptional() @IsString() @MaxLength(60) current_step?: string;
  @IsOptional() @IsBoolean() business_details_confirmed?: boolean;
  @IsOptional() @IsBoolean() upi_configured?: boolean;
  @IsOptional() @IsBoolean() razorpay_connected?: boolean;
  @IsOptional() @IsBoolean() template_chosen?: boolean;
  @IsOptional() @IsBoolean() numbering_configured?: boolean;
  @IsOptional() @IsBoolean() payment_terms_set?: boolean;
  @IsOptional() @IsBoolean() currencies_enabled?: boolean;
  @IsOptional() @IsBoolean() default_gst_set?: boolean;
  @IsOptional() @IsBoolean() default_notes_set?: boolean;
  @IsOptional() @IsBoolean() email_signature_set?: boolean;
  @IsOptional() @IsBoolean() reminder_schedule_set?: boolean;
}
