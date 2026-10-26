import fs from 'node:fs';
import path from 'node:path';

/**
 * Docker-Healthcheck: gesund, wenn health.json frisch ist (< 90 s) und der Bot verbunden ist
 * oder erst kurz (< 5 min) getrennt (Auto-Reconnect läuft).
 */
const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
try {
  const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'health.json'), 'utf8')) as {
    ts: number;
    connected: boolean;
    disconnectedSince: number | null;
  };
  const fresh = Date.now() - data.ts < 90_000;
  const ok = data.connected || (data.disconnectedSince !== null && Date.now() - data.disconnectedSince < 5 * 60_000);
  if (fresh && ok) process.exit(0);
  console.error(`unhealthy: fresh=${fresh} connected=${data.connected}`);
  process.exit(1);
} catch (err) {
  console.error(`unhealthy: ${(err as Error).message}`);
  process.exit(1);
}
