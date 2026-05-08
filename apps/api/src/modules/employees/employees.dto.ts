import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsArray,
  IsUUID,
  IsDate,
  IsBoolean,
  IsNumber,
  Min,
  MaxLength,
  ValidateNested,
  IsObject,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InviteEmployeeDto {
  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @ApiProperty({ example: 'john.doe@company.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'EMP001' })
  @IsString()
  @IsNotEmpty()
  employeeCode: string;

  @ApiProperty({ example: 'Software Engineer' })
  @IsString()
  @IsNotEmpty()
  designation: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  locationId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  managerId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  employmentType?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  joiningDate?: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  fullName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarUrl?: string;
}

export class SelfUpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  emergencyContactName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  emergencyContactPhone?: string;
}

export class OnboardingStepDto {
  @ApiProperty({ example: { personalInfo: { phone: '+91...', address: '...' } } })
  @IsObject()
  data: Record<string, unknown>;
}

export class TransferEmployeeDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  locationId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  managerId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  designation?: string;

  @ApiProperty({ example: 'Transferred to new department for project requirements' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  effectiveDate?: string;
}

export class TerminateEmployeeDto {
  @ApiProperty({ description: 'Reason for termination' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  lastWorkingDate?: string;

  @ApiPropertyOptional({ enum: ['resigned', 'terminated', 'absconded', 'retired', 'end_of_contract'] })
  @IsString()
  @IsOptional()
  separationType?: string;
}

export class EmployeeListQueryDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  locationId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  status?: string;

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
