import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_CODES,
  PROTECTED_PERMISSION_CODES,
  ROLES,
  ROLE_DEFINITIONS,
  ROLE_PERMISSION_MATRIX,
  WAREHOUSE_SCOPE_ALL,
  type RoleName,
} from '../src';

describe('@b2b/domain / rbac catalog', () => {
  it('uses the canonical colon-notation warehouse scope key', () => {
    expect(WAREHOUSE_SCOPE_ALL).toBe('warehouse:scope:all');
    // The dot-notation alias must never appear as a real code.
    expect(PERMISSION_CODES).not.toContain('warehouse.scope.all');
    expect(PERMISSION_CODES).toContain('warehouse:scope:all');
  });

  it('has unique permission codes', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });

  it('marks exactly the four SYSTEM_ADMIN-only permissions as protected', () => {
    expect([...PROTECTED_PERMISSION_CODES].sort()).toEqual(
      ['audit:read:all', 'role:manage:protected', 'system:read', 'warehouse:scope:all'].sort(),
    );
  });

  it('does NOT protect role:manage or user:assign-role (ADMIN holds them)', () => {
    for (const code of ['role:manage', 'user:assign-role']) {
      expect(PERMISSIONS.find((p) => p.code === code)?.protected, code).toBe(false);
    }
  });

  it('defines the six canonical roles with correct privilege levels', () => {
    const byName = Object.fromEntries(ROLE_DEFINITIONS.map((r) => [r.name, r]));
    expect(byName[ROLES.SYSTEM_ADMIN]).toMatchObject({
      isSystem: true,
      isProtected: true,
      privilegeLevel: 100,
    });
    expect(byName[ROLES.ADMIN]).toMatchObject({
      isSystem: true,
      isProtected: false,
      privilegeLevel: 50,
    });
    expect(Object.keys(byName).sort()).toEqual(
      ['ADMIN', 'FINANCE', 'SALES', 'SYSTEM_ADMIN', 'VIEWER', 'WAREHOUSE_MANAGER'].sort(),
    );
  });

  it('SYSTEM_ADMIN holds every permission (wildcard)', () => {
    expect([...ROLE_PERMISSION_MATRIX.SYSTEM_ADMIN].sort()).toEqual([...PERMISSION_CODES].sort());
  });

  it('grants NO protected permission to any role except SYSTEM_ADMIN', () => {
    const protectedSet = new Set(PROTECTED_PERMISSION_CODES);
    for (const role of Object.keys(ROLE_PERMISSION_MATRIX) as RoleName[]) {
      if (role === ROLES.SYSTEM_ADMIN) continue;
      for (const code of ROLE_PERMISSION_MATRIX[role]) {
        expect(protectedSet.has(code), `${role} must not hold protected ${code}`).toBe(false);
      }
    }
  });

  it('references only known permission codes in the matrix', () => {
    const known = new Set(PERMISSION_CODES);
    for (const role of Object.keys(ROLE_PERMISSION_MATRIX) as RoleName[]) {
      for (const code of ROLE_PERMISSION_MATRIX[role]) {
        expect(known.has(code), `${role}:${code}`).toBe(true);
      }
    }
  });

  it('never grants warehouse:scope:all to ADMIN', () => {
    expect(ROLE_PERMISSION_MATRIX.ADMIN).not.toContain(WAREHOUSE_SCOPE_ALL);
  });
});
