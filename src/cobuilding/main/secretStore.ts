/**
 * Encryption at rest for the secrets Acabox keeps in
 * `cobuilding-settings.json`: the Anthropic API key and connector auth
 * headers.
 *
 * Why: the settings file is mode 0644 under userData, and the chat agent has
 * auto-approved `Bash`. `cat`-ing that file is one tool call, and the value
 * then lands in the chat transcript and the message DB. That is not
 * hypothetical — it has happened, with the agent itself reporting afterwards
 * that reading Acabox's settings had printed the user's API key into the
 * conversation. Encrypting with the OS keychain makes that read useless.
 *
 * What this is NOT: protection against code running as the user that calls
 * Electron's safeStorage itself. It removes the trivially-scraped plaintext,
 * which is the realistic leak path here.
 *
 * Values are stored as `enc:v1:<base64>`. Anything without that prefix is
 * treated as a legacy plaintext value and returned as-is, so an existing
 * install keeps working and is re-encrypted on the next write.
 */
import { safeStorage } from 'electron';
import log from 'electron-log';

const PREFIX = 'enc:v1:';

/** True when the value is one of our encrypted envelopes. */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Is OS-backed encryption usable right now?
 *
 * macOS/Windows: yes once the app is ready. Linux: depends on an available
 * keyring, so it can legitimately be false. Wrapped in try/catch because
 * calling before `app.ready` throws.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * Encrypt a secret for storage. Returns the value unchanged when encryption
 * is unavailable — degrading to today's plaintext behaviour beats refusing to
 * save the user's API key on a machine with no keyring.
 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (isEncrypted(plain)) return plain; // already an envelope; don't double-wrap
  if (!isEncryptionAvailable()) {
    log.warn('[SecretStore] OS encryption unavailable — storing this secret in plain text.');
    return plain;
  }
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    log.warn(`[SecretStore] Encrypt failed, storing plain text: ${(err as Error).message}`);
    return plain;
  }
}

/**
 * Decrypt a stored secret. A legacy plaintext value passes straight through,
 * which is what makes the migration invisible to the user.
 *
 * A failed decrypt returns '' rather than the ciphertext: handing an
 * `enc:v1:…` string to the Anthropic API as a key would produce a baffling
 * auth error instead of an honest "no key".
 */
export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!isEncrypted(stored)) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch (err) {
    log.error(`[SecretStore] Could not decrypt a stored secret: ${(err as Error).message}`);
    return '';
  }
}

/** Encrypt every value of a record (header/env maps). */
export function encryptRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, encryptSecret(v)]));
}

/** Decrypt every value of a record. */
export function decryptRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, decryptSecret(v)]));
}

/**
 * Replace every value of a record with the empty string, preserving the keys.
 *
 * Used to keep secrets off the IPC boundary entirely: the Settings UI needs to
 * know that an `Authorization` header exists, never what it holds. An empty
 * value on save means "keep whatever is stored" (see
 * `connectorsStore#upsertConnector`).
 */
export function maskRecord(rec: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.keys(rec).map((k) => [k, '']));
}
