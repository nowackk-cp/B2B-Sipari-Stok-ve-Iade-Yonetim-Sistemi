'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@b2b/ui';

/**
 * Primary navigation. Every destination is a real route in this milestone. There
 * is no standalone stock-mutation screen yet, so the Inventory entry deep-links
 * into the Reports inventory tab (`/reports?tab=inventory`) rather than a dead
 * `/inventory` 404. The active route is highlighted from the pathname; entries
 * that carry a query (Inventory) never claim the highlight, leaving the canonical
 * `Reports` item active while the reports screen is open.
 */
const NAV: ReadonlyArray<{ href: string; label: string; ready: boolean }> = [
  { href: '/dashboard', label: 'Dashboard', ready: true },
  { href: '/products', label: 'Products', ready: true },
  { href: '/warehouses', label: 'Warehouses', ready: true },
  { href: '/customers', label: 'Customers', ready: true },
  { href: '/orders', label: 'Orders', ready: true },
  { href: '/invoices', label: 'Invoices', ready: true },
  { href: '/returns', label: 'Returns', ready: true },
  { href: '/credit-notes', label: 'Credit Notes', ready: true },
  { href: '/reports?tab=inventory', label: 'Inventory', ready: true },
  { href: '/reports', label: 'Reports', ready: true },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="sidebar" aria-label="Primary">
      <ul className="sidebar-nav">
        {NAV.map((item) => {
          const hrefPath = item.href.split('?')[0]!;
          const hasQuery = item.href.includes('?');
          // Query-bearing entries (Inventory report) point into a shared pathname;
          // only the canonical query-less entry claims the active highlight.
          const active =
            !hasQuery && (pathname === hrefPath || pathname.startsWith(`${hrefPath}/`));
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
