import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { DealsService } from './deals.service';
import { PipelinesService } from './pipelines.service';

class CreateDealDto {
  @IsString() @MaxLength(200) title!: string;
  @IsOptional() @IsString() pipeline_id?: string;
  @IsOptional() @IsString() stage_id?: string;
  @IsOptional() @IsString() company_id?: string;
  @IsOptional() @IsString() primary_person_id?: string;
  @IsOptional() @IsString() owner_user_id?: string;
  @IsOptional() @IsNumber() @Min(0) value_amount?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsString() expected_close_date?: string;
  @IsOptional() @IsString() source?: string;
}

class MoveStageDto {
  @IsString() stage_id!: string;
  @IsOptional() @IsString() lost_reason_id?: string;
  @IsOptional() @IsString() lost_reason_note?: string;
}

class AddProductDto {
  @IsOptional() @IsString() item_id?: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsNumber() @Min(0) quantity?: number;
  @IsNumber() @Min(0) unit_price!: number;
  @IsOptional() @IsNumber() @Min(0) discount_pct?: number;
}

class AddPersonDto {
  @IsString() person_id!: string;
  @IsOptional() @IsString() @MaxLength(60) role?: string;
}

@ApiTags('crm-deals')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class DealsController {
  constructor(
    private readonly deals: DealsService,
    private readonly pipelines: PipelinesService,
  ) {}

  // ─── Pipelines / reference ──────────────────────────────────────────────────
  @Get('pipelines')
  @RequireGrant('crm', 'view')
  listPipelines(@CurrentUser() user: JwtPayload) {
    return this.pipelines.list(user.tenantId);
  }

  @Get('lost-reasons')
  @RequireGrant('crm', 'view')
  lostReasons(@CurrentUser() user: JwtPayload) {
    return this.pipelines.lostReasons(user.tenantId);
  }

  @Get('reps')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'Active members for owner pickers / filters' })
  reps(@CurrentUser() user: JwtPayload) {
    return this.deals.reps(user.tenantId);
  }

  // ─── Board / forecast ───────────────────────────────────────────────────────
  @Get('board')
  @RequireGrant('crm', 'view')
  @ApiOperation({ summary: 'Kanban board: open deals grouped by stage with sums + rotting' })
  board(@Query('pipeline_id') pipelineId: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.deals.board(user.tenantId, pipelineId);
  }

  @Get('forecast')
  @RequireGrant('crm', 'view')
  forecast(@Query('pipeline_id') pipelineId: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.deals.forecast(user.tenantId, pipelineId);
  }

  // ─── Deals ──────────────────────────────────────────────────────────────────
  @Get('contacts/:id/deals')
  @RequireGrant('crm', 'view')
  dealsForContact(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.listForContact(user.tenantId, id);
  }

  @Get('companies/:id/deals')
  @RequireGrant('crm', 'view')
  dealsForCompany(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.listForCompany(user.tenantId, id);
  }

  @Get('deals/:id')
  @RequireGrant('crm', 'view')
  get(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.get(user.tenantId, id);
  }

  @Post('deals')
  @RequireGrant('crm', 'edit')
  create(@Body() dto: CreateDealDto, @CurrentUser() user: JwtPayload) {
    return this.deals.create(user.tenantId, user.sub, dto);
  }

  @Patch('deals/:id')
  @RequireGrant('crm', 'edit')
  update(@Param('id') id: string, @Body() dto: Record<string, unknown>, @CurrentUser() user: JwtPayload) {
    return this.deals.update(user.tenantId, user.sub, id, dto);
  }

  @Post('deals/:id/move')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Move a deal to a stage (won/lost applied on terminal stages)' })
  move(@Param('id') id: string, @Body() dto: MoveStageDto, @CurrentUser() user: JwtPayload) {
    return this.deals.moveStage(user.tenantId, user.sub, id, dto);
  }

  @Post('deals/:id/reopen')
  @Roles('owner', 'admin', 'manager')
  @RequireGrant('crm', 'edit')
  reopen(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.reopen(user.tenantId, user, id);
  }

  @Post('deals/:id/create-invoice')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Deal → DRAFT invoice (§4.4): resolve/create customer, products → lines, back-link' })
  createInvoice(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.createInvoice(user.tenantId, user.sub, id);
  }

  @Post('deals/:id/create-quote')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Deal → DRAFT quote (§4.4/§19.3): same as invoice but issues a QUOTE' })
  createQuote(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.createQuote(user.tenantId, user.sub, id);
  }

  // ─── Deal products (C3 Products tab — the lines behind invoice/quote) ────────
  @Post('deals/:id/products')
  @RequireGrant('crm', 'edit')
  @ApiOperation({ summary: 'Add a product line (deal value auto-sums)' })
  addProduct(@Param('id') id: string, @Body() dto: AddProductDto, @CurrentUser() user: JwtPayload) {
    return this.deals.addProduct(user.tenantId, user.sub, id, dto);
  }

  @Delete('deals/:id/products/:productId')
  @RequireGrant('crm', 'edit')
  removeProduct(@Param('id') id: string, @Param('productId') productId: string, @CurrentUser() user: JwtPayload) {
    return this.deals.removeProduct(user.tenantId, user.sub, id, productId);
  }

  // ─── Deal participants (C3 People tab) ────────────────────────────────────────
  @Post('deals/:id/people')
  @RequireGrant('crm', 'edit')
  addPerson(@Param('id') id: string, @Body() dto: AddPersonDto, @CurrentUser() user: JwtPayload) {
    return this.deals.addPerson(user.tenantId, user.sub, id, dto);
  }

  @Delete('deals/:id/people/:personId')
  @RequireGrant('crm', 'edit')
  removePerson(@Param('id') id: string, @Param('personId') personId: string, @CurrentUser() user: JwtPayload) {
    return this.deals.removePerson(user.tenantId, user.sub, id, personId);
  }

  @Delete('deals/:id')
  @Roles('owner', 'admin', 'manager')
  @RequireGrant('crm', 'edit')
  remove(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deals.remove(user.tenantId, user.sub, id);
  }
}
