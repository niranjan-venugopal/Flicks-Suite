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
  Max,
  Matches,
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

  @ApiPropertyOptional({ description: 'Designation FK (designations.id)' })
  @IsUUID()
  @IsOptional()
  designationId?: string;

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

// ─── Per-step employee self-onboarding payloads ──────────────────────────────

// All fields optional so the wizard can save partial progress on each step.
export class OnboardingPersonalInfoDto {
  @IsString() @IsOptional() dateOfBirth?: string;       // YYYY-MM-DD
  @IsString() @IsOptional() gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say';
  @IsString() @IsOptional() maritalStatus?: string;
  @IsString() @IsOptional() bloodGroup?: string;
  @IsString() @IsOptional() addressLine1?: string;
  @IsString() @IsOptional() addressLine2?: string;
  @IsString() @IsOptional() city?: string;
  @IsString() @IsOptional() stateCode?: string;
  @IsString() @IsOptional() postalCode?: string;
}

export class OnboardingEmergencyContactDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() relationship: string;
  @IsString() @IsNotEmpty() phone: string;
  @IsString() @IsOptional() email?: string;
}

export class OnboardingIdentityDto {
  @IsString() @IsOptional() @Matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, {
    message: 'PAN must be 5 letters + 4 digits + 1 letter (e.g. ABCDE1234F)',
  })
  pan?: string;

  @IsString() @IsOptional() personalPhone?: string;
  @IsString() @IsOptional() personalEmail?: string;
  @IsString() @IsOptional() nationality?: string;
}

export class OnboardingBankDto {
  @IsString() @IsOptional() bankName?: string;
  @IsString() @IsOptional() bankBranch?: string;
  @IsString() @IsOptional() bankAccountNumber?: string;
  @IsString() @IsOptional() bankAccountHolder?: string;
  @IsString() @IsOptional() @Matches(/^[A-Z]{4}0[A-Z0-9]{6}$/, {
    message: 'IFSC must be 4 letters + 0 + 6 alphanumeric (e.g. HDFC0001234)',
  })
  bankIfsc?: string;
  @IsString() @IsOptional() bankAccountType?: 'savings' | 'current' | 'salary';
  @IsString() @IsOptional() pfUan?: string;
}

export class SubmitOnboardingStepDto {
  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsNumber()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  step: number;

  @IsObject() @IsOptional() personalInfo?: OnboardingPersonalInfoDto;
  @IsObject() @IsOptional() emergencyContact?: OnboardingEmergencyContactDto;
  @IsObject() @IsOptional() identity?: OnboardingIdentityDto;
  @IsObject() @IsOptional() bank?: OnboardingBankDto;

  @ApiPropertyOptional({ description: 'True only on the final review step' })
  @IsBoolean() @IsOptional()
  submitForReview?: boolean;
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

  @ApiPropertyOptional({ description: 'Designation FK (designations.id)' })
  @IsUUID()
  @IsOptional()
  designationId?: string;

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
