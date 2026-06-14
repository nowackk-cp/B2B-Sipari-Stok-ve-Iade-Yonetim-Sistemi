import type { UserProfileView } from '@b2b/contracts';
import type { AuthUser } from './user.repository';

/**
 * Map an internal user to the whitelisted public profile view. Explicit field
 * selection (never spreading the record) guarantees the password hash, internal
 * bigint id, lock counters and `deletedAt` can never leak (API_CONVENTIONS §7a).
 */
export function toUserProfileView(user: AuthUser): UserProfileView {
  return {
    id: user.publicId,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    roles: user.roles,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
