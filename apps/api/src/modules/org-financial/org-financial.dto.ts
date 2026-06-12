import {
  IsString,
  IsOptional,
  IsIn,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Organization → Financial details DTOs (PRD §7.2 / §8).
 * IFSC/SWIFT formats are validated here AND by DB CHECK constraints — the API
 * layer returns the friendly message, the DB is the backstop.
 */

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const SWIFT_RE = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;

export class UpdateOrgFinancialDto {
  @IsOptional() @IsString() @MaxLength(200) legal_name?: string;
  @IsOptional()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, {
    message: 'GSTIN must match the 15-character GST format (e.g. 29ABCDE1234F1Z5)',
  })
  gstin?: string;
  @IsOptional()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/, {
    message: 'PAN must match the 10-character format (e.g. ABCDE1234F)',
  })
  pan?: string;
  @IsOptional() @IsString() cin?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) fiscal_year_start_month?: number;
  @IsOptional() @IsString() address_line1?: string;
  @IsOptional() @IsString() address_line2?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state_code?: string;
  @IsOptional() @IsString() postal_code?: string;
}

export class CreateBankAccountDto {
  @IsString() @MaxLength(200) beneficiary_name!: string;
  @IsString() @MaxLength(40) account_number!: string;
  @IsOptional() @IsIn(['Current', 'Savings', 'EEFC']) account_type?: string;
  @IsString() @MaxLength(120) bank_name!: string;
  @IsOptional() @IsString() @MaxLength(120) branch?: string;

  @IsOptional()
  @Matches(IFSC_RE, {
    message: 'IFSC must be 11 characters: 4 letters, a zero, then 6 alphanumerics (e.g. HDFC0001234)',
  })
  ifsc?: string;

  @IsOptional()
  @Matches(SWIFT_RE, {
    message: 'SWIFT/BIC must be 8 or 11 alphanumerics (e.g. HDFCINBB or HDFCINBBXXX)',
  })
  swift_bic?: string;

  @IsOptional() @IsString() @MaxLength(300) bank_address?: string;
  @IsOptional() @IsString() @MaxLength(34) iban?: string;
  @IsOptional() @IsBoolean() is_default?: boolean;
}

export class UpdateBankAccountDto extends CreateBankAccountDto {
  @IsOptional() @IsString() declare beneficiary_name: string;
  @IsOptional() @IsString() declare account_number: string;
  @IsOptional() @IsString() declare bank_name: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class SetCurrencyDefaultDto {
  @IsString() @MaxLength(3) currency!: string;
  @IsString() bank_account_id!: string;
}
