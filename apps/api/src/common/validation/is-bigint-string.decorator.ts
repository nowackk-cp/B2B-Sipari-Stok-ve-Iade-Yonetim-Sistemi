import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * Maximum value of a PostgreSQL signed `BIGINT` (2^63 − 1). Numeric fields that
 * land in a `BIGINT` column (money minor units, quantity thresholds) MUST be
 * range-checked here, at the validation boundary — otherwise an over-range value
 * passes a naive regex check, is converted to BigInt, and only fails deep inside
 * Prisma/PostgreSQL as an opaque 500 instead of a clean 400 (PRODUCT-CATALOG
 * review BLOCKER 1).
 */
export const PG_BIGINT_MAX = 9223372036854775807n;

/**
 * Whether `value` is a string that safely represents a non-negative integer
 * within PostgreSQL `BIGINT` range: digits only (no sign, no decimal point, no
 * exponent, no whitespace), non-empty, and `0 <= value <= PG_BIGINT_MAX`. This
 * is the single source of truth shared by the decorator and any service-side
 * defensive check.
 */
export function isBigIntStringInRange(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Digits only → rejects empty string, negatives, decimals, exponent, spaces.
  if (!/^\d+$/.test(value)) return false;
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    return false;
  }
  return parsed >= 0n && parsed <= PG_BIGINT_MAX;
}

/**
 * Validate that a property is a non-negative integer STRING within PostgreSQL
 * `BIGINT` range. Reusable across catalog/billing/inventory DTOs so every value
 * destined for a `BIGINT` column is rejected with a 400 (RFC7807) before it can
 * overflow the database.
 */
export function IsBigIntString(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isBigIntString',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isBigIntStringInRange(value),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} must be a non-negative integer string within PostgreSQL bigint range (0..${PG_BIGINT_MAX.toString()})`,
      },
    });
  };
}
