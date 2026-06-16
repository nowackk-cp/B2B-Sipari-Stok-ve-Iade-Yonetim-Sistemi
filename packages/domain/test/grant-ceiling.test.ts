import { describe, expect, it } from 'vitest';
import {
  GrantCeilingPolicy,
  type GrantActor,
  type GrantTargetPermission,
  type GrantTargetRole,
  type GrantTargetUser,
} from '../src';

const COMPANY_A = 1n;
const COMPANY_B = 2n;

function actor(over: Partial<GrantActor> = {}): GrantActor {
  return {
    companyId: COMPANY_A,
    permissions: new Set<string>(),
    maxPrivilegeLevel: 50,
    ...over,
  };
}
function role(over: Partial<GrantTargetRole> = {}): GrantTargetRole {
  return {
    companyId: COMPANY_A,
    privilegeLevel: 10,
    isProtected: false,
    permissions: new Set<string>(),
    ...over,
  };
}
const user = (companyId = COMPANY_A): GrantTargetUser => ({ companyId });
const perm = (code: string, isProtected = false): GrantTargetPermission => ({ code, isProtected });

describe('@b2b/domain / GrantCeilingPolicy (pure)', () => {
  describe('canAddPermissionToRole', () => {
    it('allows adding a permission the actor holds (within ceiling + manage right)', () => {
      const a = actor({ permissions: new Set(['role:manage', 'product:read']) });
      expect(GrantCeilingPolicy.canAddPermissionToRole(a, role(), perm('product:read'))).toEqual({
        allowed: true,
      });
    });

    it('denies adding a permission the actor does NOT hold (ceiling)', () => {
      const a = actor({ permissions: new Set(['role:manage']) });
      expect(GrantCeilingPolicy.canAddPermissionToRole(a, role(), perm('system:read'))).toEqual({
        allowed: false,
        reason: 'CEILING_EXCEEDED',
      });
    });

    it('denies without the base role:manage permission', () => {
      const a = actor({ permissions: new Set(['product:read']) });
      expect(GrantCeilingPolicy.canAddPermissionToRole(a, role(), perm('product:read'))).toEqual({
        allowed: false,
        reason: 'MISSING_MANAGE_PERMISSION',
      });
    });

    it('requires the protected-grant permission for a protected permission', () => {
      const a = actor({ permissions: new Set(['role:manage', 'system:read']) });
      expect(
        GrantCeilingPolicy.canAddPermissionToRole(a, role(), perm('system:read', true)),
      ).toEqual({ allowed: false, reason: 'PROTECTED_GRANT_REQUIRED' });
    });

    it('allows a protected permission when actor holds protected-grant AND the permission', () => {
      const a = actor({
        permissions: new Set(['role:manage', 'role:manage:protected', 'system:read']),
        maxPrivilegeLevel: 100,
      });
      expect(
        GrantCeilingPolicy.canAddPermissionToRole(a, role(), perm('system:read', true)),
      ).toEqual({ allowed: true });
    });

    it('requires protected-grant when the ROLE is protected, even for a normal permission', () => {
      const a = actor({ permissions: new Set(['role:manage', 'product:read']) });
      expect(
        GrantCeilingPolicy.canAddPermissionToRole(
          a,
          role({ isProtected: true }),
          perm('product:read'),
        ),
      ).toEqual({ allowed: false, reason: 'PROTECTED_GRANT_REQUIRED' });
    });

    it('denies a cross-tenant role', () => {
      const a = actor({ permissions: new Set(['role:manage', 'product:read']) });
      expect(
        GrantCeilingPolicy.canAddPermissionToRole(
          a,
          role({ companyId: COMPANY_B }),
          perm('product:read'),
        ),
      ).toEqual({ allowed: false, reason: 'CROSS_TENANT' });
    });

    it('denies when the role outranks the actor (privilege ceiling)', () => {
      const a = actor({
        permissions: new Set(['role:manage', 'product:read']),
        maxPrivilegeLevel: 20,
      });
      expect(
        GrantCeilingPolicy.canAddPermissionToRole(
          a,
          role({ privilegeLevel: 50 }),
          perm('product:read'),
        ),
      ).toEqual({ allowed: false, reason: 'PRIVILEGE_LEVEL_EXCEEDED' });
    });
  });

  describe('canRemovePermissionFromRole', () => {
    it('is gated identically to adding (protected role denies an ADMIN-level actor)', () => {
      const a = actor({
        permissions: new Set(['role:manage', 'system:read']),
        maxPrivilegeLevel: 50,
      });
      expect(
        GrantCeilingPolicy.canRemovePermissionFromRole(
          a,
          role({ isProtected: true, privilegeLevel: 100 }),
          perm('system:read', true),
        ),
      ).toEqual({ allowed: false, reason: 'PROTECTED_GRANT_REQUIRED' });
    });
  });

  describe('canAssignRoleToUser', () => {
    it('allows assigning a role whose permissions are all within the actor ceiling', () => {
      const a = actor({ permissions: new Set(['user:assign-role', 'product:read', 'order:read']) });
      const r = role({ permissions: new Set(['product:read']) });
      expect(GrantCeilingPolicy.canAssignRoleToUser(a, user(), r)).toEqual({ allowed: true });
    });

    it('denies assigning a role containing a permission the actor lacks', () => {
      const a = actor({ permissions: new Set(['user:assign-role', 'product:read']) });
      const r = role({ permissions: new Set(['product:read', 'system:read']) });
      expect(GrantCeilingPolicy.canAssignRoleToUser(a, user(), r)).toEqual({
        allowed: false,
        reason: 'CEILING_EXCEEDED',
      });
    });

    it('denies assigning a protected role without protected-grant', () => {
      const a = actor({ permissions: new Set(['user:assign-role']), maxPrivilegeLevel: 100 });
      const r = role({ isProtected: true, privilegeLevel: 100 });
      expect(GrantCeilingPolicy.canAssignRoleToUser(a, user(), r)).toEqual({
        allowed: false,
        reason: 'PROTECTED_GRANT_REQUIRED',
      });
    });

    it('denies a protected role over the ceiling even WITH protected-grant', () => {
      const a = actor({
        permissions: new Set(['user:assign-role', 'role:manage:protected']),
        maxPrivilegeLevel: 100,
      });
      const r = role({
        isProtected: true,
        privilegeLevel: 100,
        permissions: new Set(['role:manage:protected', 'system:read']),
      });
      expect(GrantCeilingPolicy.canAssignRoleToUser(a, user(), r)).toEqual({
        allowed: false,
        reason: 'CEILING_EXCEEDED',
      });
    });

    it('denies a cross-tenant target user', () => {
      const a = actor({ permissions: new Set(['user:assign-role']) });
      expect(GrantCeilingPolicy.canAssignRoleToUser(a, user(COMPANY_B), role())).toEqual({
        allowed: false,
        reason: 'CROSS_TENANT',
      });
    });

    it('denies a higher-ranked role (no self/other escalation above rank)', () => {
      const a = actor({ permissions: new Set(['user:assign-role']), maxPrivilegeLevel: 50 });
      expect(
        GrantCeilingPolicy.canAssignRoleToUser(a, user(), role({ privilegeLevel: 100 })),
      ).toEqual({ allowed: false, reason: 'PRIVILEGE_LEVEL_EXCEEDED' });
    });
  });

  it('is deny-by-default: an actor with no permissions can do nothing', () => {
    const a = actor({ permissions: new Set(), maxPrivilegeLevel: -1 });
    expect(GrantCeilingPolicy.canAssignRoleToUser(a, user(), role()).allowed).toBe(false);
    expect(GrantCeilingPolicy.canAddPermissionToRole(a, role(), perm('product:read')).allowed).toBe(
      false,
    );
  });
});
