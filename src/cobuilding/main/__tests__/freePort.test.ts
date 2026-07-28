/**
 * Pins the port-probe bug that let a dev Acabox drive the packaged app's
 * agent server.
 *
 * Both host servers bind `127.0.0.1`. The probe used to bind `0.0.0.0`, which
 * on macOS succeeds anyway — so an occupied port was reported free, and the
 * subsequent /health check then found the *other* install's agent server and
 * adopted it.
 */
import * as net from 'net';
import { findFreePort, isPortBindable, LOOPBACK } from '../freePort';

function listenOn(host: string, port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** An ephemeral port that is free right now. */
async function borrowPort(): Promise<number> {
  const s = await listenOn(LOOPBACK, 0);
  const port = (s.address() as net.AddressInfo).port;
  await close(s);
  return port;
}

describe('isPortBindable', () => {
  it('is false while another process holds the port on loopback', async () => {
    const port = await borrowPort();
    const holder = await listenOn(LOOPBACK, port);
    try {
      expect(await isPortBindable(port)).toBe(false);
    } finally {
      await close(holder);
    }
    expect(await isPortBindable(port)).toBe(true);
  });
});

describe('findFreePort', () => {
  it('skips a port occupied on loopback — the packaged-app case', async () => {
    // This is the exact scenario: a packaged Acabox is serving on the first
    // port of the range, and a second instance must not pick it.
    const first = await borrowPort();
    const holder = await listenOn(LOOPBACK, first);
    try {
      const chosen = await findFreePort(first, first + 20);
      expect(chosen).not.toBe(first);
      expect(chosen).toBeGreaterThan(first);
    } finally {
      await close(holder);
    }
  });

  it('returns the first port when nothing holds it', async () => {
    const port = await borrowPort();
    expect(await findFreePort(port, port + 20)).toBe(port);
  });

  it('rejects when every port in the range is taken', async () => {
    const start = await borrowPort();
    const holders = [
      await listenOn(LOOPBACK, start),
      await listenOn(LOOPBACK, start + 1),
    ];
    try {
      await expect(findFreePort(start, start + 1)).rejects.toThrow(/No free port/);
    } finally {
      await Promise.all(holders.map(close));
    }
  });

});

// Wildcard-vs-loopback bind semantics are platform-specific, so these assert
// only on the platform Acabox ships to. Together they show why the probe must
// mirror the server's own bind rather than be "stricter" or "looser".
const onDarwin = process.platform === 'darwin' ? describe : describe.skip;
onDarwin('wildcard vs loopback on macOS', () => {
  it('a 0.0.0.0 bind succeeds while loopback is held — this is why the old probe lied', async () => {
    const port = await borrowPort();
    const holder = await listenOn(LOOPBACK, port);        // e.g. packaged Acabox
    try {
      const wildcard = await listenOn('0.0.0.0', port);   // old probe: "free" ✗
      await close(wildcard);
      expect(await isPortBindable(port)).toBe(false);     // new probe: "taken" ✓
    } finally {
      await close(holder);
    }
  });

  it('a loopback bind succeeds while the wildcard is held, and the probe correctly says so', async () => {
    // The reverse direction is permissive too, so probing loopback is NOT
    // stricter than probing the wildcard. That's fine — and the point: the
    // probe answers exactly the question the agent server's own
    // listen(port, '127.0.0.1') will ask, so a "free" verdict here really
    // does mean the server can bind.
    const port = await borrowPort();
    const holder = await listenOn('0.0.0.0', port);
    try {
      expect(await isPortBindable(port)).toBe(true);
      const real = await listenOn(LOOPBACK, port);        // what the server does
      await close(real);                                  // ...and it works
    } finally {
      await close(holder);
    }
  });
});
