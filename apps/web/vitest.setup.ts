import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// A base URL must exist for the API client; tests mock `fetch`, so the host is
// never actually contacted.
process.env.NEXT_PUBLIC_API_BASE_URL ||= 'http://api.test/api/v1';

// Unmount React trees between tests (no `globals: true`, so register manually).
afterEach(() => cleanup());
