import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { tokens } from '@b2b/ui';
import './globals.css';

export const metadata: Metadata = {
  title: `${tokens.brand} — Console`,
  description: 'Back-office operations console.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
