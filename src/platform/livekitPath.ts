/**
 * @fluxerjs/voice verwirft den Pfad des Voice-Endpoints (z. B. /livekit) und
 * verbindet nur mit wss://host. Fluxer hängt LiveKit aber hinter einen Pfad.
 * Wir fangen Room.connect ab und setzen den Pfad wieder ein.
 */
let base: { host: string; path: string } | null = null;
let patched = false;

type ConnectFn = (url: string, ...rest: unknown[]) => Promise<unknown>;

export async function applyLivekitBase(endpoint: string): Promise<void> {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`);
    const path = u.pathname.replace(/\/+$/, '');
    base = path ? { host: u.host, path } : null;
  } catch {
    base = null;
  }
  if (patched || !base) return;
  const name = '@livekit/rtc-node';
  const mod = (await import(name)) as { Room: { prototype: { connect: ConnectFn } } };
  const orig = mod.Room.prototype.connect;
  mod.Room.prototype.connect = function (this: unknown, url: string, ...rest: unknown[]) {
    if (base) {
      try {
        const t = new URL(url);
        if (t.host === base.host && (t.pathname === '/' || t.pathname === '')) {
          url = `${t.protocol}//${t.host}${base.path}`;
        }
      } catch {
        /* URL unverändert lassen */
      }
    }
    return orig.call(this, url, ...rest);
  };
  patched = true;
}
