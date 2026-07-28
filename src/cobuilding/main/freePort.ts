/**
 * Free-port probing for the host child processes (agent server, kernel
 * gateway).
 *
 * Standalone and electron-free so the probe can be unit-tested directly —
 * getting this wrong is not theoretical. The probe used to bind `0.0.0.0`
 * while both servers bind `127.0.0.1`. On macOS a wildcard bind SUCCEEDS
 * while another process holds the loopback address, so a dev instance would
 * call port 23200 "free" while a packaged Acabox was serving on it, then
 * adopt the packaged app's agent server through the /health check and drive
 * the wrong workspace with the wrong API key.
 *
 * The rule is that the probe must perform *exactly the bind the server will
 * perform*, not a stricter or looser one. Measured on macOS, wildcard and
 * loopback binds do not collide in either direction: holding `0.0.0.0:P`
 * still lets you bind `127.0.0.1:P`, and vice versa. So probing loopback is
 * not "stricter" than probing the wildcard — it is simply the same question
 * the real `listen()` asks, which is what makes its answer trustworthy. (Both
 * cases are covered in freePort.test.ts.)
 */
import * as net from 'net';

/** The interface the agent server and kernel gateway actually bind. */
export const LOOPBACK = '127.0.0.1';

/** Can we bind this port on loopback right now? */
export function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, LOOPBACK, () => {
      server.close(() => resolve(true));
    });
  });
}

/** First bindable port in `[start, end]`. Rejects when the range is full. */
export function findFreePort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = () => {
      if (port > end) {
        reject(new Error(`No free port in range ${start}-${end}`));
        return;
      }
      const server = net.createServer();
      server.listen(port, LOOPBACK, () => {
        server.close(() => resolve(port));
      });
      server.on('error', () => {
        port++;
        tryNext();
      });
    };
    tryNext();
  });
}
