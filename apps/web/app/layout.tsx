import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { tokens } from '@b2b/ui';
import './globals.css';

export const metadata: Metadata = {
  title: `${tokens.brand} — Console`,
  description: 'Back-office operations console (foundation).',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <header className="app-header">
          <h1>{tokens.brand}</h1>
          <div className="subtitle">Operations Console · Foundation</div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
