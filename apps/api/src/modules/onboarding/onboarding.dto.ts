import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsEnum,
  IsNumber,
  MinLength,
  MaxLength,
  Matches,
  IsBoolean,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CheckSlugDto {
  @ApiProperty({ example: 'acme-corp', description: 'URL-safe slug for the tenant' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers and hyphens',
  })
  slug: string;
}

export class CreateTenantDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'acme-corp' })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase letters, numbers and hyphens',
  })
  slug: string;

  @ApiPropertyOptional({ example: 'Technology' })
  @IsString()
  @IsOptional()
  industry?: string;

  @ApiPropertyOptional({ example: '11-50' })
  @IsString()
  @IsOptional()
  sizeBand?: string;
}

export class UpdateTenantDetailsDto {
  @ApiPropertyOptional({ example: 'Acme Corporation Pvt Ltd' })
  @IsString()
  @IsOptional()
  legalName?: string;

  @ApiPropertyOptional({ example: '27AABCU9603R1ZX', description: '15-character GSTIN' })
  @IsString()
  @IsOptional()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, {
    message: 'Invalid GSTIN format',
  })
  gstin?: string;

  @ApiPropertyOptional({ example: 'AABCU9603R', description: '10-character PAN' })
  @IsString()
  @IsOptional()
  @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, { message: 'Invalid PAN format' })
  pan?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  cin?: string;

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
  postalCode?: string;
}

export class CreateDepartmentsDto {
  @ApiProperty({ example: ['Engineering', 'HR', 'Finance'], description: 'Department names' })
  @IsArray()
  @IsString({ each: true })
  names: string[];
}

export class ChecklistTaskDto {
  @ApiProperty({ description: 'Task identifier' })
  @IsString()
  @IsNotEmpty()
  taskId: string;
}
