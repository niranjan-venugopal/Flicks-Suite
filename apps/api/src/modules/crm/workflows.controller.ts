import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CrmGrantGuard } from '../../core/auth/guards/crm-grant.guard';
import { RequireGrant } from '../../core/auth/decorators/require-grant.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import type { JwtPayload } from '@flicks/shared/types';
import { WorkflowsService, WORKFLOW_TRIGGERS, type WorkflowAction, type WorkflowCondition } from './workflows.service';

class CreateWorkflowDto {
  @IsString() @MaxLength(120) name!: string;
  @IsString() trigger!: string;
  // @Type(() => Object) is REQUIRED here: with enableImplicitConversion the
  // pipe otherwise rewrites each untyped JSON element into an empty array.
  // The service deep-validates shape and rejects missing/empty actions.
  @IsOptional() @IsArray() @Type(() => Object) conditions?: WorkflowCondition[];
  @IsOptional() @IsArray() @Type(() => Object) actions?: WorkflowAction[];
  @IsOptional() @IsBoolean() active?: boolean;
}

class SetActiveDto {
  @IsBoolean() active!: boolean;
}

/** Workflows (C12, §8): trigger → conditions → actions, Manager and above. */
@ApiTags('crm-workflows')
@Controller('crm')
@UseGuards(CrmGrantGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('workflows')
  @RequireGrant('crm', 'view')
  list(@CurrentUser() user: JwtPayload) {
    return this.workflows.list(user.tenantId);
  }

  @Get('workflows/triggers')
  @RequireGrant('crm', 'view')
  triggers() {
    return { data: WORKFLOW_TRIGGERS };
  }

  @Post('workflows')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  @ApiOperation({ summary: 'Create a workflow (validated trigger/conditions/actions; beta caps apply)' })
  create(@Body() dto: CreateWorkflowDto, @CurrentUser() user: JwtPayload) {
    return this.workflows.create(user.tenantId, user.sub, dto);
  }

  @Patch('workflows/:id/active')
  @RequireGrant('crm', 'edit')
  @Roles('owner', 'admin', 'manager')
  setActive(@Param('id') id: string, @Body() dto: SetActiveDto, @CurrentUser() user: JwtPayload) {
    return this.workflows.setActive(user.tenantId, user.sub, id, dto.active);
  }

  @Get('workflow-runs')
  @RequireGrant('crm', 'view')
  runs(@Query('workflow_id') workflowId: string | undefined, @CurrentUser() user: JwtPayload) {
    return this.workflows.runs(user.tenantId, workflowId);
  }
}
