import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NumberingService } from './numbering.service';
import { UpsertSequenceDto, PreviewNumberDto } from './dto/invoicing.dto';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { InvoicingGrantGuard } from '../../core/auth/guards/invoicing-grant.guard';
import type { JwtPayload } from '@flicks/shared/types';

@ApiTags('Invoicing — Numbering')
@ApiBearerAuth('access-token')
@UseGuards(InvoicingGrantGuard)
@Controller('invoice-sequences')
export class NumberingController {
  constructor(private readonly numbering: NumberingService) {}

  @Get()
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'List current-FY sequences (all document types)' })
  list(@CurrentUser() user: JwtPayload) {
    return this.numbering.list(user.tenantId);
  }

  @Get('preview')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Preview the next number for a document type' })
  previewGet(@Query() dto: PreviewNumberDto, @CurrentUser() user: JwtPayload) {
    return this.numbering.preview(user.tenantId, dto);
  }

  @Post('preview')
  @RequireGrant('invoicing', 'view')
  @ApiOperation({ summary: 'Preview the next number for a proposed config' })
  previewPost(@Body() dto: PreviewNumberDto, @CurrentUser() user: JwtPayload) {
    return this.numbering.preview(user.tenantId, dto);
  }

  @Put()
  @RequireGrant('invoicing', 'edit')
  @ApiOperation({
    summary: 'Create/update a sequence config (warns on mid-FY change)',
  })
  upsert(@Body() dto: UpsertSequenceDto, @CurrentUser() user: JwtPayload) {
    return this.numbering.upsert(user.tenantId, dto, user.sub);
  }
}
