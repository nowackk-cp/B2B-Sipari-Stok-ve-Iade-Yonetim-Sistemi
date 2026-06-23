import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../app/components/sidebar';

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

function hrefOf(label: string): string {
  return (
    screen.getByRole('link', { name: new RegExp(`^${label}`, 'i') }).getAttribute('href') ?? ''
  );
}

describe('Sidebar', () => {
  it('points the Reports link at the real /reports route', () => {
    pathname = '/dashboard';
    render(<Sidebar />);
    expect(hrefOf('Reports')).toBe('/reports');
  });

  it('routes the Inventory entry to the reports inventory tab (no dead /inventory 404)', () => {
    pathname = '/dashboard';
    render(<Sidebar />);
    const inventory = hrefOf('Inventory');
    expect(inventory).toBe('/reports?tab=inventory');
    expect(inventory).not.toBe('/inventory');
  });

  it('every nav link targets a real app route (no placeholder dead links)', () => {
    pathname = '/dashboard';
    render(<Sidebar />);
    const realRoutes = new Set([
      '/dashboard',
      '/products',
      '/warehouses',
      '/customers',
      '/orders',
      '/invoices',
      '/returns',
      '/credit-notes',
      '/reports',
      '/reports?tab=inventory',
    ]);
    for (const link of screen.getAllByRole('link')) {
      expect(realRoutes.has(link.getAttribute('href') ?? '')).toBe(true);
    }
  });

  it('highlights the active route and not the query-bearing twin', () => {
    pathname = '/reports';
    render(<Sidebar />);
    const reports = screen.getByRole('link', { name: /^Reports/i });
    expect(reports.getAttribute('aria-current')).toBe('page');
    const inventory = screen.getByRole('link', { name: /^Inventory/i });
    expect(inventory.getAttribute('aria-current')).toBeNull();
  });
});
