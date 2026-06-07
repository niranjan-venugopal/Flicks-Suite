import { Injectable, NotImplementedException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { ListQueryDto, CreateItemDto } from './dto/invoicing.dto';

/** Items catalogue service (scaffold — Sprint 2). */
@Injectable()
export class ItemsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(_tenantId: string, query: ListQueryDto) {
    return {
      data: [],
      meta: { page: query.page ?? 1, limit: query.limit ?? 20, total: 0 },
    };
  }

  async get(_tenantId: string, _id: string) {
    throw new NotImplementedException('Items.get — Sprint 2');
  }

  async create(_dto: CreateItemDto, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Items.create — Sprint 2');
  }

  async update(_id: string, _dto: unknown, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Items.update — Sprint 2');
  }

  async archive(_id: string, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Items.archive — Sprint 2');
  }
}
