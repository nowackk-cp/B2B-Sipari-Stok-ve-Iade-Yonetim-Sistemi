import type { HealthStatus } from '@b2b/shared';
import { StatusBadge } from './components/status-badge';
import { createServerApiClient, getApiBaseUrl } from '../src/lib/api';

// Health is request-time state, never statically cached.
export const dynamic = 'force-dynamic';

type ApiProbe = { reachable: true; health: HealthStatus } | { reachable: false; error: string };

async function probeApi(): Promise<ApiProbe> {
  try {
    const health = await createServerApiClient().getReadiness();
    return { reachable: true, health };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : 'unreachable' };
  }
}

/** Infrastructure components and their status in the foundation milestone. */
const INFRA = [
  { name: 'API (NestJS)', detail: '/api/v1 · health · Swagger', state: 'ok' as const },
  { name: 'Worker (BullMQ)', detail: 'queue infra · no processors yet', state: 'pending' as const },
  { name: 'PostgreSQL', detail: 'schema lands in TASK-004', state: 'pending' as const },
  { name: 'Redis', detail: 'queue/cache backend', state: 'pending' as const },
  { name: 'MinIO / Mailpit', detail: 'object storage · mail (dev)', state: 'pending' as const },
];

export default async function HomePage() {
  const probe = await probeApi();

  return (
    <>
      <div className="grid">
        <section className="panel">
          <h2>Application</h2>
          <div className="kv">
            <span className="key">Name</span>
            <span>B2B Operations Suite</span>
          </div>
          <div className="kv">
            <span className="key">Milestone</span>
            <span>Foundation 1A</span>
          </div>
          <div className="kv">
            <span className="key">API base URL</span>
            <span>{getApiBaseUrl()}</span>
          </div>
        </section>

        <section className="panel">
          <h2>API health</h2>
          {probe.reachable ? (
            <>
              <div className="kv">
                <span className="key">Status</span>
                <StatusBadge state={probe.health.status} />
              </div>
              <div className="kv">
                <span className="key">Service</span>
                <span>{probe.health.service}</span>
              </div>
              <div className="kv">
                <span className="key">Version</span>
                <span>{probe.health.version}</span>
              </div>
              <div className="kv">
                <span className="key">Environment</span>
                <span>{probe.health.environment}</span>
              </div>
            </>
          ) : (
            <>
              <div className="kv">
                <span className="key">Status</span>
                <StatusBadge state="error" />
              </div>
              <div className="kv">
                <span className="key">Detail</span>
                <span>API unreachable — start the API to see live status.</span>
              </div>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Infrastructure</h2>
          {INFRA.map((item) => (
            <div className="kv" key={item.name}>
              <span className="key" title={item.detail}>
                {item.name}
              </span>
              <StatusBadge state={item.state} />
            </div>
          ))}
        </section>
      </div>

      <p className="note">
        This is the foundation shell. Authentication, RBAC and business modules (catalog, stock,
        orders, transfers, returns, invoicing) are delivered in later milestones. The frontend talks
        only to <code>/api/v1</code> — it never connects to the database directly.
      </p>
    </>
  );
}
