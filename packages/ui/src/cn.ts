export type ClassValue = string | number | null | false | undefined | ClassValue[];

/**
 * Combine class names, ignoring falsy values and flattening arrays.
 * A dependency-free `clsx`-style helper used by the web app's layout.
 */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) out.push(nested);
    } else {
      out.push(String(value));
    }
  }
  return out.join(' ');
}
