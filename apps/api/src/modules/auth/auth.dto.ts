import {
  IsEmail,
  IsString,
  IsNotEmpty,
  IsOptional,
  Length,
  IsUUID,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
  @IsUUID()
  @IsNotEmpty()
  tenantId: string;
}

export class LogoutDto {
  @ApiPropertyOptional({ description: 'Specific refresh token to revoke' })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}
