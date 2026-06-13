/**
 * SelectTenantDto validates UUID *format*, not RFC version/variant — so
 * company switching works for tenants whose ids are seed/demo UUIDs (e.g.
 * 11111111-…), which Postgres accepts but @IsUUID() would reject. Regression
 * for the "tenantId must be a UUID" 400 on switch-company / select-tenant.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SelectTenantDto } from '../modules/auth/auth.dto';

const validate = (tenantId: unknown) =>
  validateSync(plainToInstance(SelectTenantDto, { tenantId }));

describe('SelectTenantDto tenantId validation', () => {
  it('accepts proper RFC v4 UUIDs', () => {
    expect(validate('a2fa23d7-9b4c-4dc8-a8eb-fc54eb521c5c')).toHaveLength(0);
  });

  it('accepts seed/demo UUIDs that Postgres allows but @IsUUID() rejects', () => {
    for (const id of [
      '11111111-1111-1111-1111-111111111111',
      '00000000-0000-0000-0000-000000000001',
      '12345678-1234-1234-1234-123456789abc',
    ]) {
      expect(validate(id)).toHaveLength(0);
    }
  });

  it('rejects non-UUID-shaped values', () => {
    for (const bad of ['', 'not-a-uuid', '123', undefined, 'a2fa23d7-9b4c-4dc8-a8eb']) {
      expect(validate(bad).length).toBeGreaterThan(0);
    }
  });
});
