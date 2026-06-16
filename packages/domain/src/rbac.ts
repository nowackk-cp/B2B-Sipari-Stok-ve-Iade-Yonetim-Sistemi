/**
 * RBAC catalog — the single source of truth for permissions, roles and the
 * seed role→permission matrix.
 *
 * Consumed by the database seed (`@b2b/database`), database/RBAC tests and (in
 * later tasks) the API permission guards. Keeping this here — in the pure,
 * framework-independent domain package — guarantees one canonical spelling of
 * every permission code and role name across seed, tests and docs.
 *
 * Authority: docs/PERMISSION_MATRIX.md, docs/architecture/SECURITY_MODEL.md.
 */

/**
 * Canonical global warehouse-scope permission. The `<resource>:<action>` colon
 * spelling is canonical; `warehouse.scope.all` is only an equivalent prose
 * alias and is NOT used as a key anywhere. Protected — only SYSTEM_ADMIN holds
 * or assigns it. No role grants implicit global scope (ADMIN included).
 */
export const WAREHOUSE_SCOPE_ALL = 'warehouse:scope:all' as const;

/**
 * Grant-management permission codes referenced by the grant-ceiling policy.
 *
 * - {@link ROLE_MANAGE_PERMISSION} / {@link USER_ASSIGN_ROLE_PERMISSION}: the
 *   non-protected base capability to manage role grants / assign roles. ADMIN
 *   holds both in seed, bounded at runtime by the grant ceiling.
 * - {@link PROTECTED_GRANT_PERMISSION}: the right to *touch* a protected role or
 *   a protected permission. It is an ALIAS of the existing catalog permission
 *   `role:manage:protected` (no new permission is introduced). Holding it is
 *   necessary but NOT sufficient: the actor must still be in-tenant and stay
 *   within their own effective-permission/privilege ceiling.
 */
export const ROLE_MANAGE_PERMISSION = 'role:manage' as const;
export const ROLE_MANAGE_PROTECTED_PERMISSION = 'role:manage:protected' as const;
export const USER_ASSIGN_ROLE_PERMISSION = 'user:assign-role' as const;
export const PROTECTED_GRANT_PERMISSION = ROLE_MANAGE_PROTECTED_PERMISSION;

/** Permission grouping (UI grouping + protected policy bucket). */
export const PERMISSION_GROUPS = [
  'IDENTITY',
  'RBAC',
  'WAREHOUSE_SCOPE',
  'CATALOG',
  'WAREHOUSE',
  'INVENTORY',
  'TRANSFER',
  'CUSTOMER',
  'ORDER',
  'RETURN',
  'BILLING',
  'FILE',
  'IMPORT',
  'EXPORT',
  'NOTIFICATION',
  'AUDIT',
  'DASHBOARD',
  'SYSTEM',
] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionDef {
  /** `<resource>:<action>` code — canonical, unique. */
  readonly code: string;
  /** Owning module. */
  readonly module: string;
  /** UI / policy grouping. */
  readonly group: PermissionGroup;
  /**
   * Protected permission (`permissions.is_protected = true`). Only SYSTEM_ADMIN
   * may hold/assign it; never seeded onto ADMIN or lower. DB cannot enforce the
   * actor, so the service-layer grant ceiling is mandatory on top of this flag.
   */
  readonly protected: boolean;
  readonly description: string;
}

/**
 * Full permission catalog. `protected: true` is set for EXACTLY the four
 * SYSTEM_ADMIN-only permissions per PERMISSION_MATRIX note¹:
 * `role:manage:protected`, `warehouse:scope:all`, `audit:read:all`,
 * `system:read`. `role:manage` and `user:assign-role` are NOT protected — ADMIN
 * holds them in seed, bounded at runtime by the grant ceiling.
 */
export const PERMISSIONS: readonly PermissionDef[] = [
  // identity
  {
    code: 'user:read',
    module: 'identity',
    group: 'IDENTITY',
    protected: false,
    description: 'View users',
  },
  {
    code: 'user:create',
    module: 'identity',
    group: 'IDENTITY',
    protected: false,
    description: 'Create/invite user',
  },
  {
    code: 'user:update',
    module: 'identity',
    group: 'IDENTITY',
    protected: false,
    description: 'Update user',
  },
  {
    code: 'user:deactivate',
    module: 'identity',
    group: 'IDENTITY',
    protected: false,
    description: 'Deactivate user (soft)',
  },
  // authorization
  {
    code: 'role:read',
    module: 'authorization',
    group: 'RBAC',
    protected: false,
    description: 'View roles/permissions',
  },
  {
    code: 'role:manage',
    module: 'authorization',
    group: 'RBAC',
    protected: false,
    description: 'Create/delete roles, assign non-protected permissions',
  },
  {
    code: 'role:manage:protected',
    module: 'authorization',
    group: 'RBAC',
    protected: true,
    description: 'Manage protected roles/permissions (SYSTEM_ADMIN only)',
  },
  {
    code: 'user:assign-role',
    module: 'authorization',
    group: 'RBAC',
    protected: false,
    description: 'Assign roles to users (bounded by grant ceiling)',
  },
  // scope
  {
    code: WAREHOUSE_SCOPE_ALL,
    module: 'scope',
    group: 'WAREHOUSE_SCOPE',
    protected: true,
    description: 'Global access to all warehouses (SYSTEM_ADMIN only)',
  },
  {
    code: 'user:assign-warehouse',
    module: 'scope',
    group: 'WAREHOUSE_SCOPE',
    protected: false,
    description: 'Manage user warehouse scope (within own scope)',
  },
  // catalog
  {
    code: 'product:read',
    module: 'catalog',
    group: 'CATALOG',
    protected: false,
    description: 'View products',
  },
  {
    code: 'product:create',
    module: 'catalog',
    group: 'CATALOG',
    protected: false,
    description: 'Create products',
  },
  {
    code: 'product:update',
    module: 'catalog',
    group: 'CATALOG',
    protected: false,
    description: 'Update products',
  },
  {
    code: 'product:delete',
    module: 'catalog',
    group: 'CATALOG',
    protected: false,
    description: 'Soft-delete products',
  },
  {
    code: 'category:manage',
    module: 'catalog',
    group: 'CATALOG',
    protected: false,
    description: 'Manage categories',
  },
  // warehouses
  {
    code: 'warehouse:read',
    module: 'warehouses',
    group: 'WAREHOUSE',
    protected: false,
    description: 'View warehouses',
  },
  {
    code: 'warehouse:manage',
    module: 'warehouses',
    group: 'WAREHOUSE',
    protected: false,
    description: 'Manage warehouses (legacy umbrella; granular create/update/delete preferred)',
  },
  {
    code: 'warehouse:create',
    module: 'warehouses',
    group: 'WAREHOUSE',
    protected: false,
    description: 'Create warehouses',
  },
  {
    code: 'warehouse:update',
    module: 'warehouses',
    group: 'WAREHOUSE',
    protected: false,
    description: 'Update warehouses',
  },
  {
    code: 'warehouse:delete',
    module: 'warehouses',
    group: 'WAREHOUSE',
    protected: false,
    description: 'Soft-delete warehouses',
  },
  // inventory
  {
    code: 'stock:read',
    module: 'inventory',
    group: 'INVENTORY',
    protected: false,
    description: 'View balances + ledger',
  },
  {
    code: 'stock:receive',
    module: 'inventory',
    group: 'INVENTORY',
    protected: false,
    description: 'Goods receipt',
  },
  {
    code: 'stock:adjust',
    module: 'inventory',
    group: 'INVENTORY',
    protected: false,
    description: 'Stock adjustment',
  },
  // transfers
  {
    code: 'transfer:create',
    module: 'transfers',
    group: 'TRANSFER',
    protected: false,
    description: 'Create transfer',
  },
  {
    code: 'transfer:approve',
    module: 'transfers',
    group: 'TRANSFER',
    protected: false,
    description: 'Approve transfer',
  },
  {
    code: 'transfer:dispatch',
    module: 'transfers',
    group: 'TRANSFER',
    protected: false,
    description: 'Dispatch transfer (source out)',
  },
  {
    code: 'transfer:receive',
    module: 'transfers',
    group: 'TRANSFER',
    protected: false,
    description: 'Receive transfer (destination in)',
  },
  {
    code: 'transfer:cancel',
    module: 'transfers',
    group: 'TRANSFER',
    protected: false,
    description: 'Cancel transfer',
  },
  // customers
  {
    code: 'customer:read',
    module: 'customers',
    group: 'CUSTOMER',
    protected: false,
    description: 'View customers',
  },
  {
    code: 'customer:create',
    module: 'customers',
    group: 'CUSTOMER',
    protected: false,
    description: 'Create customers',
  },
  {
    code: 'customer:update',
    module: 'customers',
    group: 'CUSTOMER',
    protected: false,
    description: 'Update customers',
  },
  {
    code: 'customer:delete',
    module: 'customers',
    group: 'CUSTOMER',
    protected: false,
    description: 'Soft-delete customers',
  },
  // orders
  {
    code: 'order:read',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'View orders',
  },
  {
    code: 'order:create',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Create orders',
  },
  {
    code: 'order:update',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Update draft orders',
  },
  {
    code: 'order:approve',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Approve order (reserve stock)',
  },
  {
    code: 'order:prepare',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Mark order preparing',
  },
  {
    code: 'order:ship',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Ship order (deduct stock)',
  },
  {
    code: 'order:cancel',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Cancel order (release stock)',
  },
  {
    code: 'order:price:override',
    module: 'orders',
    group: 'ORDER',
    protected: false,
    description: 'Override line list price (reason + audit)',
  },
  // returns
  {
    code: 'return:read',
    module: 'returns',
    group: 'RETURN',
    protected: false,
    description: 'View returns',
  },
  {
    code: 'return:create',
    module: 'returns',
    group: 'RETURN',
    protected: false,
    description: 'Create returns',
  },
  {
    code: 'return:approve',
    module: 'returns',
    group: 'RETURN',
    protected: false,
    description: 'Approve returns',
  },
  {
    code: 'return:receive',
    module: 'returns',
    group: 'RETURN',
    protected: false,
    description: 'Receive returns (restock)',
  },
  // billing
  {
    code: 'invoice:read',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'View invoices',
  },
  {
    code: 'invoice:create',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Create draft invoices',
  },
  {
    code: 'invoice:issue',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Issue invoice (assign number)',
  },
  {
    code: 'invoice:void',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Void invoice',
  },
  {
    code: 'payment:record',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Record payment',
  },
  {
    code: 'credit-note:create',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Create credit note',
  },
  {
    code: 'quote:read',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'View quotes',
  },
  {
    code: 'quote:create',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Create quotes',
  },
  {
    code: 'quote:update',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Update quotes',
  },
  {
    code: 'quote:send',
    module: 'billing',
    group: 'BILLING',
    protected: false,
    description: 'Send quotes',
  },
  // files
  {
    code: 'file:read',
    module: 'files',
    group: 'FILE',
    protected: false,
    description: 'View/download files',
  },
  {
    code: 'file:upload',
    module: 'files',
    group: 'FILE',
    protected: false,
    description: 'Upload files',
  },
  {
    code: 'file:delete',
    module: 'files',
    group: 'FILE',
    protected: false,
    description: 'Delete files',
  },
  // imports / exports
  {
    code: 'import:run',
    module: 'imports',
    group: 'IMPORT',
    protected: false,
    description: 'Run Excel import',
  },
  {
    code: 'export:run',
    module: 'exports',
    group: 'EXPORT',
    protected: false,
    description: 'Run Excel/CSV export',
  },
  // notifications
  {
    code: 'notification:read',
    module: 'notifications',
    group: 'NOTIFICATION',
    protected: false,
    description: 'Read notifications',
  },
  // audit
  {
    code: 'audit:read',
    module: 'audit',
    group: 'AUDIT',
    protected: false,
    description: 'View audit (own module/scope)',
  },
  {
    code: 'audit:read:all',
    module: 'audit',
    group: 'AUDIT',
    protected: true,
    description: 'View all audit (system-wide, SYSTEM_ADMIN only)',
  },
  // dashboard
  {
    code: 'dashboard:read',
    module: 'dashboard',
    group: 'DASHBOARD',
    protected: false,
    description: 'View dashboard',
  },
  // system
  {
    code: 'system:read',
    module: 'system',
    group: 'SYSTEM',
    protected: true,
    description: 'View job/system logs (SYSTEM_ADMIN only)',
  },
] as const;

/** All permission codes. */
export const PERMISSION_CODES: readonly string[] = PERMISSIONS.map((p) => p.code);

/** Codes flagged `is_protected = true` (SYSTEM_ADMIN-only). */
export const PROTECTED_PERMISSION_CODES: readonly string[] = PERMISSIONS.filter(
  (p) => p.protected,
).map((p) => p.code);

export interface RoleDef {
  readonly name: string;
  readonly description: string;
  /** System role (seeded, never deletable through normal endpoints). */
  readonly isSystem: boolean;
  /** Protected role — managed only by SYSTEM_ADMIN (`role:manage:protected`). */
  readonly isProtected: boolean;
  /** Grant-ceiling comparison level (SYSTEM_ADMIN=100, ADMIN=50, others <50). */
  readonly privilegeLevel: number;
}

export const ROLES = {
  SYSTEM_ADMIN: 'SYSTEM_ADMIN',
  ADMIN: 'ADMIN',
  WAREHOUSE_MANAGER: 'WAREHOUSE_MANAGER',
  SALES: 'SALES',
  FINANCE: 'FINANCE',
  VIEWER: 'VIEWER',
} as const;
export type RoleName = (typeof ROLES)[keyof typeof ROLES];

export const ROLE_DEFINITIONS: readonly RoleDef[] = [
  {
    name: ROLES.SYSTEM_ADMIN,
    description: 'Protected system superuser (wildcard).',
    isSystem: true,
    isProtected: true,
    privilegeLevel: 100,
  },
  {
    name: ROLES.ADMIN,
    description: 'Back-office administrator (grant-ceiling bound).',
    isSystem: true,
    isProtected: false,
    privilegeLevel: 50,
  },
  {
    name: ROLES.WAREHOUSE_MANAGER,
    description: 'Inventory, transfers and fulfilment.',
    isSystem: true,
    isProtected: false,
    privilegeLevel: 30,
  },
  {
    name: ROLES.SALES,
    description: 'Customers, orders, quotes and returns.',
    isSystem: true,
    isProtected: false,
    privilegeLevel: 20,
  },
  {
    name: ROLES.FINANCE,
    description: 'Invoicing, payments and credit notes.',
    isSystem: true,
    isProtected: false,
    privilegeLevel: 20,
  },
  {
    name: ROLES.VIEWER,
    description: 'Read-only across modules.',
    isSystem: true,
    isProtected: false,
    privilegeLevel: 10,
  },
] as const;

const ADMIN_PERMISSIONS: readonly string[] = [
  'user:read',
  'user:create',
  'user:update',
  'user:deactivate',
  'role:read',
  'role:manage',
  'user:assign-role',
  'user:assign-warehouse',
  'product:read',
  'product:create',
  'product:update',
  'product:delete',
  'category:manage',
  'warehouse:read',
  'warehouse:manage',
  'warehouse:create',
  'warehouse:update',
  'warehouse:delete',
  'stock:read',
  'stock:receive',
  'stock:adjust',
  'transfer:create',
  'transfer:approve',
  'transfer:dispatch',
  'transfer:receive',
  'transfer:cancel',
  'customer:read',
  'customer:create',
  'customer:update',
  'customer:delete',
  'order:read',
  'order:create',
  'order:update',
  'order:approve',
  'order:prepare',
  'order:ship',
  'order:cancel',
  'order:price:override',
  'return:read',
  'return:create',
  'return:approve',
  'return:receive',
  'invoice:read',
  'invoice:create',
  'invoice:issue',
  'invoice:void',
  'payment:record',
  'credit-note:create',
  'quote:read',
  'quote:create',
  'quote:update',
  'quote:send',
  'file:read',
  'file:upload',
  'file:delete',
  'import:run',
  'export:run',
  'notification:read',
  'audit:read',
  'dashboard:read',
];

const WAREHOUSE_MANAGER_PERMISSIONS: readonly string[] = [
  'product:read',
  'warehouse:read',
  'stock:read',
  'stock:receive',
  'stock:adjust',
  'transfer:create',
  'transfer:approve',
  'transfer:dispatch',
  'transfer:receive',
  'transfer:cancel',
  'customer:read',
  'order:read',
  'order:prepare',
  'order:ship',
  'return:read',
  'return:receive',
  'file:read',
  'file:upload',
  'file:delete',
  'import:run',
  'export:run',
  'notification:read',
  'dashboard:read',
];

const SALES_PERMISSIONS: readonly string[] = [
  'product:read',
  'warehouse:read',
  'stock:read',
  'customer:read',
  'customer:create',
  'customer:update',
  'order:read',
  'order:create',
  'order:update',
  'order:approve',
  'order:cancel',
  'order:price:override',
  'return:read',
  'return:create',
  'return:approve',
  'invoice:read',
  'quote:read',
  'quote:create',
  'quote:update',
  'quote:send',
  'file:read',
  'file:upload',
  'file:delete',
  'export:run',
  'notification:read',
  'dashboard:read',
];

const FINANCE_PERMISSIONS: readonly string[] = [
  'product:read',
  'warehouse:read',
  'stock:read',
  'customer:read',
  'order:read',
  'return:read',
  'invoice:read',
  'invoice:create',
  'invoice:issue',
  'invoice:void',
  'payment:record',
  'credit-note:create',
  'quote:read',
  'quote:create',
  'quote:update',
  'quote:send',
  'file:read',
  'file:upload',
  'file:delete',
  'export:run',
  'notification:read',
  'audit:read',
  'dashboard:read',
];

const VIEWER_PERMISSIONS: readonly string[] = [
  'product:read',
  'warehouse:read',
  'stock:read',
  'customer:read',
  'order:read',
  'return:read',
  'invoice:read',
  'quote:read',
  'file:read',
  'notification:read',
  'dashboard:read',
];

/**
 * Seed role→permission matrix.
 *
 * - SYSTEM_ADMIN holds EVERY permission (incl. protected) — wildcard authority.
 * - ADMIN and below hold ONLY non-protected permissions; no role is seeded with
 *   any protected permission except SYSTEM_ADMIN, and no role receives implicit
 *   warehouse scope.
 */
export const ROLE_PERMISSION_MATRIX: Readonly<Record<RoleName, readonly string[]>> = {
  [ROLES.SYSTEM_ADMIN]: PERMISSION_CODES,
  [ROLES.ADMIN]: ADMIN_PERMISSIONS,
  [ROLES.WAREHOUSE_MANAGER]: WAREHOUSE_MANAGER_PERMISSIONS,
  [ROLES.SALES]: SALES_PERMISSIONS,
  [ROLES.FINANCE]: FINANCE_PERMISSIONS,
  [ROLES.VIEWER]: VIEWER_PERMISSIONS,
};
