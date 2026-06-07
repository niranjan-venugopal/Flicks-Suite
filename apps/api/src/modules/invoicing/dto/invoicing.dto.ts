import {
  IsString,
  IsOptional,
  IsInt,
  IsEmail,
  IsArray,
  IsNumberString,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Invoicing DTOs (scaffold). Validation shapes for the core resources; the
 * full field set + business validation is fleshed out per resource in Sprints
 * 2–3. Kept intentionally small so the module compiles and the routes are
 * exercised end-to-end.
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

  @ApiPropertyOptional({ description: 'Status filter' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class CreateCustomerDto {
  @IsString()
  @MaxLength(120)
  display_name!: string;

  @IsOptional()
  @IsString()
  legal_name?: string;

  @IsOptional()
  @IsIn(['business', 'individual'])
  customer_type?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  gstin?: string;

  @IsOptional()
  @IsString()
  state_code?: string;

  @IsOptional()
  @IsString()
  default_currency?: string;
}

export class CreateItemDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsNumberString()
  default_rate!: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  hsn_sac_code?: string;

  @IsOptional()
  @IsNumberString()
  default_gst_rate?: string;
}

export class CreateInvoiceDto {
  @IsString()
  customer_id!: string;

  @IsString()
  invoice_date!: string;

  @IsString()
  due_date!: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsArray()
  line_items?: unknown[];
}

export class HsnSacSearchDto {
  @IsString()
  @MaxLength(120)
  q!: string;

  @ApiPropertyOptional({ enum: ['HSN', 'SAC'] })
  @IsOptional()
  @IsIn(['HSN', 'SAC'])
  type?: string;
}
