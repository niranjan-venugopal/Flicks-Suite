import { Injectable, NotImplementedException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import type { ListQueryDto, CreateInvoiceDto } from './dto/invoicing.dto';

/**
 * Invoices service (scaffold — Sprint 3 brings CRUD, the GST/TDS engine,
 * lifecycle transitions, numbering reservation, and send/preview).
 */
@Injectable()
export class InvoicesService {
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
    throw new NotImplementedException('Invoices.get — Sprint 3');
  }

  async create(_dto: CreateInvoiceDto, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Invoices.create — Sprint 3');
  }

  async update(_id: string, _dto: unknown, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Invoices.update (DRAFT only) — Sprint 3');
  }

  async send(_id: string, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Invoices.send — Sprint 4');
  }

  async recordPayment(_id: string, _dto: unknown, _userId: string, _tenantId: string) {
    throw new NotImplementedException('Invoices.recordPayment — Sprint 4');
  }
}
