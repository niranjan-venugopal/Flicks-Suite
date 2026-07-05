import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsString,
  IsNotEmpty,
  IsOptional,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Signup clickwrap (PRD v4 §3.4). Rides verify-otp — the user-creation moment. */
export class SignupConsentDto {
  @ApiProperty({ enum: ['terms_privacy', 'analytics', 'marketing_email'] })
  @IsIn(['terms_privacy', 'analytics', 'marketing_email'])
  type: 'terms_privacy' | 'analytics' | 'marketing_email';

  @ApiProperty()
  @IsBoolean()
  granted: boolean;
}

export class RequestOtpDto {
  @ApiProperty({ example: 'user@example.com', description: 'User email address' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsNotEmpty()
  email: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: '123456', description: '6-digit OTP code' })
  @IsString()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'OTP must contain only digits' })
  code: string;

  @ApiPropertyOptional({ description: 'Device fingerprint for trusted device tracking' })
  @IsString()
  @IsOptional()
  deviceId?: string;

  @ApiPropertyOptional({
    description:
      'Signup clickwrap consents (§3.4). Required (with terms_privacy granted) when this verification creates a NEW account.',
    type: [SignupConsentDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SignupConsentDto)
  consents?: SignupConsentDto[];

  @ApiPropertyOptional({ description: 'Detected region (ISO alpha-2), advisory' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  regionCode?: string;
}

export class MagicLinkVerifyDto {
  @ApiProperty({ description: 'Magic link token from email' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  deviceId?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Current refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  deviceId?: string;
}

export class SelectTenantDto {
  @ApiProperty({ description: 'Tenant UUID to switch to' })
  @IsNotEmpty()
  // Validate UUID *format* (8-4-4-4-12 hex) rather than @IsUUID(), which also
  // enforces the RFC version/variant nibbles. Postgres' `uuid` type accepts any
  // 128-bit value in that shape, so seed/demo tenants created with non-RFC ids
  // (e.g. 11111111-1111-1111-1111-111111111111) are valid everywhere — RLS,
  // joins, /me — yet @IsUUID() would reject them here and 400 every company
  // switch into such a tenant. Match Postgres' notion of a UUID instead.
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
    message: 'tenantId must be a valid UUID',
  })
  tenantId: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Specific refresh token to revoke' })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}

export class TotpCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Code must be 6 digits' })
  code: string;
}

export class TotpVerifyDto {
  @ApiProperty({ description: 'Challenge token from the OTP/magic-link step' })
  @IsString()
  @IsNotEmpty()
  challengeToken: string;

  @ApiProperty({ example: '123456', description: '6-digit TOTP code' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Code must be 6 digits' })
  code: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  deviceId?: string;
}
