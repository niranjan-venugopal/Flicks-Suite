import { Injectable, NotImplementedException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { ListQueryDto, CreateCustomerDto } from './dto/invoicing.dto';

/**
 * Customers service (scaffold — Sprint 2 fills in CRUD, import/export,
 * statements). Structure mirrors the V1 module pattern: tenant queries run
 * through databaseService.withTenant; every mutation writes auditService.log.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(_tenantId: string, query: ListQueryDto) {
    // Sprint 2: SELECT … FROM customers (tenant-scoped via withTenant).
    return {
      data: [],
      meta: { page: query.page ?? 1, limit: query.limit ?? 20, total: 0 },
    };
  }

  async get(_tenantId: string, _id: string) {
    throw new NotImplementedException('Customers.get — Sprint 2');
  }

  async create(_dto: CreateCustomerDto, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Customers.create — Sprint 2');
  }

  async update(_id: string, _dto: unknown, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Customers.update — Sprint 2');
  }

  async archive(_id: string, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Customers.archive — Sprint 2');
  }
}
