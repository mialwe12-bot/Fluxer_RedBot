import fs from 'node:fs';
import path from 'node:path';

/** Entfernt nach dem Testlauf die temporären Cog-Bundles. */
export default function setup(): () => void {
  return () => {
    const dir = path.resolve('.cogcache');
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('test-')) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  };
}
