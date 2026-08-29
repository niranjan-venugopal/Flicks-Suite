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
  IsInt,
  IsNumber,
  Min,
  Max,
  Matches,
  MaxLength,
  ValidateNested,
  IsObject,
  IsIn,
  IsDateString,
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

  // ─── Optional pre-fills captured on the Invite form ────────────────────
  // The prototype's ScrAddEmployee collects these so the invitee doesn't
  // have to retype basics; the wizard still lets them edit them later.

  @ApiPropertyOptional({ description: 'Free-text job title for the offer letter.' })
  @IsString()
  @IsOptional()
  jobTitle?: string;

  @ApiPropertyOptional({ description: 'Personal phone — pre-fills the wizard.' })
  @IsString()
  @IsOptional()
  personalPhone?: string;

  @ApiPropertyOptional({ example: '1995-03-14' })
  @IsString()
  @IsOptional()
  dateOfBirth?: string;

  // ─── Employment terms set by HR at hire time ───────────────────────────
  // Confirmation date deliberately absent — a hire isn't confirmed yet;
  // it's set later via UpdateEmployeeDto.

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsDateString()
  @IsOptional()
  probationEndDate?: string;

  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: 365 })
  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  @Type(() => Number)
  noticePeriodDays?: number;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(20)
  workPhone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(20)
  personalPhone?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  designationId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarUrl?: string;

  // ── Admin-editable org/employment fields (owner/HR profile editing) ──
  @ApiPropertyOptional({ example: 'EMP007' })
  @IsString()
  @IsOptional()
  @MaxLength(24)
  employeeCode?: string;

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
  reportingManagerId?: string;

  @ApiPropertyOptional({ enum: ['full_time', 'part_time', 'contract', 'intern', 'consultant', 'probation'] })
  @IsIn(['full_time', 'part_time', 'contract', 'intern', 'consultant', 'probation'])
  @IsOptional()
  employmentType?: string;

  @ApiPropertyOptional({ example: '2026-01-15' })
  @IsDateString()
  @IsOptional()
  dateOfJoining?: string;

  @ApiPropertyOptional({ example: '2026-04-30' })
  @IsDateString()
  @IsOptional()
  probationEndDate?: string;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsDateString()
  @IsOptional()
  dateOfConfirmation?: string;

  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: 365 })
  @IsInt()
  @Min(0)
  @Max(365)
  @IsOptional()
  @Type(() => Number)
  noticePeriodDays?: number;
}

export class ImportEmployeeRowDto {
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

  // Resolved by NAME against the tenant's existing records (CSV authors
  // don't have UUIDs). Unmatched names are reported as a per-row error.
  @ApiPropertyOptional({ description: 'Department name (resolved to id)' })
  @IsString()
  @IsOptional()
  department?: string;

  @ApiPropertyOptional({ description: 'Designation title (resolved to id)' })
  @IsString()
  @IsOptional()
  designation?: string;

  @ApiPropertyOptional({ description: 'Location name (resolved to id)' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  employmentType?: string;

  @ApiPropertyOptional({ example: '2026-01-15' })
  @IsString()
  @IsOptional()
  joiningDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  jobTitle?: string;
}

export class ImportEmployeesDto {
  @ApiProperty({ type: [ImportEmployeeRowDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportEmployeeRowDto)
  rows: ImportEmployeeRowDto[];
}

export class RejectOnboardingDto {
  @ApiPropertyOptional({ description: 'Reason shown to the employee' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
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

  // Only the last 4 digits ever reach the server (client truncates); the full
  // Aadhaar number is never transmitted or stored.
  @IsString() @IsOptional() @Matches(/^\d{4}$/, {
    message: 'aadhaarLast4 must be exactly 4 digits',
  })
  aadhaarLast4?: string;

  // Passport / national ID for employees outside India (encrypted at rest).
  @IsString() @IsOptional() @MaxLength(20)
  passportNumber?: string;

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

export class OnboardingConsentDto {
  @ApiProperty({
    enum: [
      'data_processing',
      'marketing',
      'background_check',
      'biometric_data',
      'third_party_sharing',
    ],
  })
  @IsIn([
    'data_processing',
    'marketing',
    'background_check',
    'biometric_data',
    'third_party_sharing',
  ])
  type: string;

  @ApiProperty()
  @IsBoolean()
  granted: boolean;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  purpose?: string;
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

  @ApiPropertyOptional({ type: [OnboardingConsentDto], description: 'DPDP consents — captured on the final review step' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OnboardingConsentDto)
  @IsOptional()
  consents?: OnboardingConsentDto[];

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

// ─── Detail change requests (employee confirmation of HR edits) ──────────────

export class RejectChangeRequestDto {
  @ApiPropertyOptional({ example: 'That is not my account number' })
  @IsString()
  @IsOptional()
  @MaxLength(300)
  reason?: string;
}
