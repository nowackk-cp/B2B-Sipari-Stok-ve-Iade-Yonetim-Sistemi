'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { listWarehouses } from '../../../src/lib/warehouses-client';
import { SalesReport } from '../../components/reports/sales-report';
import { InventoryReport } from '../../components/reports/inventory-report';
import { ReturnsReport } from '../../components/reports/returns-report';
import type { WarehouseOption } from '../../components/reports/report-helpers';

const TABS = [
  { key: 'sales', label: 'Sales' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'returns', label: 'Returns' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function isTab(value: string | null): value is TabKey {
  return value === 'sales' || value === 'inventory' || value === 'returns';
}

/**
 * Reports screen. A single page with a Sales / Inventory / Returns segmented
 * control; each tab owns its endpoint and its loading/empty/error+retry states.
 * The initial tab can be deep-linked via `?tab=` (the Inventory sidebar entry
 * routes here as `/reports?tab=inventory` — there is no standalone stock screen
 * in this milestone). Only the active tab is mounted, so switching tabs fires
 * exactly that tab's request.
 *
 * The optional warehouse filter is populated once from the caller's in-scope
 * warehouses (best-effort: if that read fails the filter is simply hidden — the
 * report still works, scoped server-side). No `companyId`/tenant claim is ever
 * sent from the client.
 */
function ReportsView() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = useState<TabKey>(isTab(tabParam) ? tabParam : 'sales');
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);

  // Keep the selected tab in sync with `?tab=` for same-route navigation. The
  // App Router does not remount this page when only the query changes (e.g.
  // clicking the Inventory sidebar entry while already on /reports), so the
  // once-seeded initial state would otherwise go stale. A manual tab click does
  // not touch the URL, so `tabParam` is unchanged and this effect is a no-op.
  useEffect(() => {
    if (isTab(tabParam)) setTab(tabParam);
  }, [tabParam]);

  useEffect(() => {
    let active = true;
    listWarehouses({ limit: 100 })
      .then((page) => {
        if (active) {
          setWarehouses(page.data.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` })));
        }
      })
      .catch(() => {
        // Warehouse filter is a convenience; a failed list must not break reports.
        if (active) setWarehouses([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const body = useMemo(() => {
    switch (tab) {
      case 'inventory':
        return <InventoryReport warehouses={warehouses} />;
      case 'returns':
        return <ReturnsReport warehouses={warehouses} />;
      default:
        return <SalesReport warehouses={warehouses} />;
    }
  }, [tab, warehouses]);

  return (
    <section aria-label="reports">
      <div className="page-head">
        <h1 className="page-title">Reports</h1>
      </div>

      <div className="segmented" role="tablist" aria-label="report sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`segmented-item${tab === t.key ? ' is-active' : ''}`}
            onClick={() => setTab(t.key)}
            data-testid={`reports-tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {body}
    </section>
  );
}

export default function ReportsPage() {
  // useSearchParams must sit under a Suspense boundary (Next App Router).
  return (
    <Suspense
      fallback={
        <div className="table-state" aria-busy="true">
          Loading reports…
        </div>
      }
    >
      <ReportsView />
    </Suspense>
  );
}
