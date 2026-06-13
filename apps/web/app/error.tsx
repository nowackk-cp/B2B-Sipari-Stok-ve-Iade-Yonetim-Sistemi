'use client';

import { useEffect } from 'react';

/** Root error boundary for the App Router. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Render error', error);
  }, [error]);

  return (
    <div className="center-screen" role="alert">
      <h2>Something went wrong</h2>
      <p>An unexpected error occurred while rendering this page.</p>
      {error.digest ? <p className="note">Reference: {error.digest}</p> : null}
      <button className="button" onClick={reset} type="button">
        Try again
      </button>
    </div>
  );
}
