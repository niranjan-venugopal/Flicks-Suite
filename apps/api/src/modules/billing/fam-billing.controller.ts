import {
  Delete,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { BillingExempt } from '../../core/auth/decorators/billing-exempt.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { FamBillingService } from './fam-billing.service';

class BatchCreateDto {
  @IsString()
  @MaxLength(20)
  prefix!: string;

  @IsIn(['random', 'sequential'])
  mode!: 'random' | 'sequential';

  @IsInt()
  @Min(1)
  @Max(500)
  count!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  months!: number;

  @IsString()
  @MaxLength(60)
  campaign!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  max_redemptions?: number;

  @IsOptional()
  @IsISO8601()
  expires_at?: string;
}

class CouponUpdateDto {
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** FAM coupon console + billing overview (PRD v4 D21/D22, Sprint 22). */
@ApiTags('FAM · Billing')
@ApiBearerAuth('access-token')
@BillingExempt()
@Roles('fam')
@Controller('fam')
export class FamBillingController {
  constructor(private readonly famBilling: FamBillingService) {}

  @Post('coupons/batch')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Mint a coupon batch (sequential or random suffixes)' })
  batch(@Body() dto: BatchCreateDto, @CurrentUser() user: JwtPayload) {
    return this.famBilling.batchCreate(user.sub, dto);
  }

  @Get('coupons')
  @ApiOperation({ summary: 'List coupons (filters: campaign, active)' })
  list(@Query('campaign') campaign?: string, @Query('active') active?: string) {
    return this.famBilling.list({ campaign, active });
  }

  @Get('coupons/export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="coupons.csv"')
  @ApiOperation({ summary: 'CSV of coupon codes (optionally one campaign)' })
  exportCsv(@Query('campaign') campaign?: string) {
    return this.famBilling.exportCsv(campaign);
  }

  @Patch('coupons/:id')
  @ApiOperation({ summary: 'Deactivate / reactivate a coupon (audited)' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CouponUpdateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.famBilling.update(user.sub, id, dto);
  }

  @Delete('coupons/:id')
  @ApiOperation({ summary: 'Delete an UNREDEEMED coupon (409 if it has redemptions — deactivate those instead)' })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.famBilling.remove(user.sub, id);
  }

  @Get('coupons/:id/redemptions')
  @ApiOperation({ summary: 'Who redeemed this code (tenant + redeemer + when)' })
  redemptions(@Param('id', ParseUUIDPipe) id: string) {
    return this.famBilling.redemptions(id);
  }

  @Get('billing/overview')
  @ApiOperation({ summary: 'Revenue tiles: platform MRR · active subs · trial→paid (D22)' })
  overview() {
    return this.famBilling.overview();
  }
}
