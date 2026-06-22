import { redirect } from 'next/navigation';

/**
 * Entry route. The app is dashboard-first; the protected layout will bounce
 * unauthenticated visitors on to `/login`.
 */
export default function HomePage() {
  redirect('/dashboard');
}
