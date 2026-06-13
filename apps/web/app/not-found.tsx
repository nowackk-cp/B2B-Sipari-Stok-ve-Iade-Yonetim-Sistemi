import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="center-screen">
      <h2>Page not found</h2>
      <p>The page you are looking for does not exist.</p>
      <Link href="/">Back to console</Link>
    </div>
  );
}
