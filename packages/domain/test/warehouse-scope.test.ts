import { describe, expect, it } from 'vitest';
import {
  WAREHOUSE_SCOPE_ALL,
  WarehouseScopePolicy,
  type ScopeActor,
  type ScopeWarehouse,
} from '../src';

const COMPANY_A = 1n;
const COMPANY_B = 2n;
const WH_1 = 10n;
const WH_2 = 20n;

function actor(over: Partial<ScopeActor> = {}): ScopeActor {
  return {
    companyId: COMPANY_A,
    permissions: new Set<string>(),
    scopedWarehouseIds: new Set<bigint>(),
    ...over,
  };
}
const warehouse = (id = WH_1, companyId = COMPANY_A): ScopeWarehouse => ({ id, companyId });

describe('@b2b/domain / WarehouseScopePolicy (pure)', () => {
  it('denies when the actor lacks the required permission (no warehouse leak)', () => {
    const a = actor({ scopedWarehouseIds: new Set([WH_1]) }); // has scope but not the perm
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(), 'stock:read'),
    ).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });

  it('denies when the actor has the permission but no warehouse scope (rule: base perm only)', () => {
    const a = actor({ permissions: new Set(['stock:read']) });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(), 'stock:read'),
    ).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('allows with the permission AND an explicit scope for that warehouse', () => {
    const a = actor({ permissions: new Set(['stock:read']), scopedWarehouseIds: new Set([WH_1]) });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(WH_1), 'stock:read'),
    ).toEqual({ allowed: true });
  });

  it('denies when the explicit scope is for a DIFFERENT warehouse', () => {
    const a = actor({ permissions: new Set(['stock:read']), scopedWarehouseIds: new Set([WH_2]) });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(WH_1), 'stock:read'),
    ).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('allows any same-company warehouse with warehouse:scope:all (no explicit grant needed)', () => {
    const a = actor({ permissions: new Set(['stock:read', WAREHOUSE_SCOPE_ALL]) });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(WH_1), 'stock:read'),
    ).toEqual({ allowed: true });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(WH_2), 'stock:read'),
    ).toEqual({ allowed: true });
  });

  it('denies a cross-company warehouse even with warehouse:scope:all (scope:all is per-tenant)', () => {
    const a = actor({ permissions: new Set(['stock:read', WAREHOUSE_SCOPE_ALL]) });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(
        a,
        warehouse(WH_1, COMPANY_B),
        'stock:read',
      ),
    ).toEqual({ allowed: false, reason: 'CROSS_TENANT' });
  });

  it('denies a cross-company warehouse even with a (cross-tenant) explicit scope id', () => {
    // A forged/legacy scope id for another tenant's warehouse cannot bypass the
    // tenant gate (the DB composite FK makes such a row un-insertable anyway).
    const a = actor({ permissions: new Set(['stock:read']), scopedWarehouseIds: new Set([WH_1]) });
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(
        a,
        warehouse(WH_1, COMPANY_B),
        'stock:read',
      ),
    ).toEqual({ allowed: false, reason: 'CROSS_TENANT' });
  });

  it('checks permission BEFORE scope: scope:all without the base permission still denies', () => {
    const a = actor({ permissions: new Set([WAREHOUSE_SCOPE_ALL]) }); // global scope, no stock:read
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(), 'stock:read'),
    ).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });

  it('is permission-specific: a scope grant only unlocks the permission the actor holds', () => {
    const a = actor({ permissions: new Set(['stock:read']), scopedWarehouseIds: new Set([WH_1]) });
    // Holds + scoped for stock:read…
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(WH_1), 'stock:read'),
    ).toEqual({ allowed: true });
    // …but a different permission it does not hold is denied even on the same warehouse.
    expect(
      WarehouseScopePolicy.canAccessWarehouseForPermission(a, warehouse(WH_1), 'stock:adjust'),
    ).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });
});
