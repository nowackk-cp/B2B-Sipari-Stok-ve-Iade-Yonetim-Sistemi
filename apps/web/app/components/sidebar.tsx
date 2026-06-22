'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@b2b/ui';

/**
 * Primary navigation. Most destinations are placeholders in this milestone —
 * only Dashboard is wired. The active route is highlighted from the pathname.
 */
const NAV: ReadonlyArray<{ href: string; label: string; ready: boolean }> = [
  { href: '/dashboard', label: 'Dashboard', ready: true },
  { href: '/products', label: 'Products', ready: true },
  { href: '/warehouses', label: 'Warehouses', ready: true },
  { href: '/customers', label: 'Customers', ready: true },
  { href: '/orders', label: 'Orders', ready: true },
  { href: '/inventory', label: 'Inventory', ready: false },
  { href: '/invoices', label: 'Invoices', ready: false },
  { href: '/returns', label: 'Returns', ready: false },
  { href: '/reports', label: 'Reports', ready: false },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Primary">
      <ul className="sidebar-nav">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn('sidebar-link', active && 'is-active', !item.ready && 'is-soon')}
                aria-current={active ? 'page' : undefined}
                aria-disabled={!item.ready || undefined}
                title={item.ready ? undefined : 'Coming soon'}
              >
                <span>{item.label}</span>
                {item.ready ? null : <span className="sidebar-soon">soon</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
