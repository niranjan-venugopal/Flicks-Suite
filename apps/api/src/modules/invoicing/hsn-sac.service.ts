import { Injectable, NotImplementedException } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import type { HsnSacSearchDto } from './dto/invoicing.dto';

/**
 * HSN/SAC lookup service (scaffold — Sprint 2 implements search over the global
 * hsn_sac_codes master + tenant custom additions). hsn_sac_codes has no RLS
 * (global, read-only), so search runs without tenant scoping.
 */
@Injectable()
export class HsnSacService {
  constructor(private readonly db: DatabaseService) {}

  async search(_dto: HsnSacSearchDto) {
    // Sprint 2: ILIKE/trigram over code + description, ordered by popularity.
    return { data: [] };
  }

  async addCustom(_dto: unknown, _userId: string, _tenantId: string) {
    throw new NotImplementedException('HsnSac.addCustom — Sprint 2');
  }
}
