#!/usr/bin/env node
// Smoke-check that the dev infrastructure ports accept TCP connections.
// Used after `docker compose up -d`. No external dependencies.
import net from 'node:net';

const TARGETS = [
  { name: 'postgres', host: '127.0.0.1', port: Number(process.env.POSTGRES_PORT ?? 5432) },
  { name: 'redis', host: '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379) },
  { name: 'minio', host: '127.0.0.1', port: Number(process.env.MINIO_PORT ?? 9000) },
  { name: 'mailpit', host: '127.0.0.1', port: Number(process.env.MAILPIT_SMTP_PORT ?? 1025) },
];

function probe({ host, port }, timeoutMs = 2000) {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

const results = await Promise.all(TARGETS.map(async (t) => ({ ...t, ok: await probe(t) })));

let failed = false;
for (const r of results) {
  const status = r.ok ? 'OK' : 'UNREACHABLE';
  if (!r.ok) failed = true;
  console.log(`${r.name.padEnd(10)} ${r.host}:${r.port}  ${status}`);
}

if (failed) {
  console.error('\nOne or more infrastructure services are not reachable.');
  process.exit(1);
}
console.log('\nAll infrastructure services reachable.');
