import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { tokens } from '@b2b/ui';
import './globals.css';

export const metadata: Metadata = {
  title: `${tokens.brand} — Console`,
  description: 'Back-office operations console.',
};

// The console is an authenticated, client-data-driven SPA shell: every screen
// probes the session and fetches live data in the browser. Static prerendering
// at build time has nothing to render and trips Next's SSG path, so render every
// route dynamically (this segment config cascades to all nested routes).
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
