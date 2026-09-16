/**
 * `validateHostedServer` mirrors `validateConnector` (`connectors.test.ts`) on
 * purpose: hosted server ids and connector ids share one namespace (both end
 * up as `mcp__<id>__<tool>`), so the two validators are checked here against
 * each other's fixtures rather than just against their own.
 */
import { validateHostedServer, isToolSelected, hostedRuntime, type HostedMcpRecord, type HostedInstallSource } from '../hostedMcp';
import { validateConnector, RESERVED_CONNECTOR_IDS, CONNECTOR_ID_PATTERN } from '../connectors';

function record(overrides: Partial<Pick<HostedMcpRecord, 'id' | 'entry' | 'concurrency'>> = {}) {
  return {
    id: 'files',
    entry: { command: '/usr/bin/node', args: ['server.js'] },
    ...overrides,
  };
}

describe('validateHostedServer', () => {
  it('accepts a well-formed record with no existing ids', () => {
    expect(validateHostedServer(record())).toEqual({ ok: true });
  });

  it('requires a non-blank id', () => {
    expect(validateHostedServer(record({ id: '' })).ok).toBe(false);
    expect(validateHostedServer(record({ id: '   ' })).ok).toBe(false);
  });

  it('requires a command in `entry`', () => {
    expect(validateHostedServer(record({ entry: { command: '', args: [] } })).ok).toBe(false);
    expect(validateHostedServer({ id: 'files' }).ok).toBe(false); // no entry at all
  });

  it('rejects concurrency that is not a positive whole number, when supplied', () => {
    expect(validateHostedServer(record({ concurrency: 0 })).ok).toBe(false);
    expect(validateHostedServer(record({ concurrency: -1 })).ok).toBe(false);
    expect(validateHostedServer(record({ concurrency: 1.5 })).ok).toBe(false);
    expect(validateHostedServer(record({ concurrency: 3 })).ok).toBe(true);
  });

  it('allows concurrency to be omitted (the caller defaults it, not this function)', () => {
    expect(validateHostedServer(record()).ok).toBe(true);
  });

  describe('the shared id namespace with connectors', () => {
    it('refuses a hosted id that collides with an EXISTING connector id', () => {
      const existingConnectorIds = ['hex', 'sentry'];
      const result = validateHostedServer(record({ id: 'hex' }), existingConnectorIds);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already exists/i);
    });

    it('refuses every RESERVED_CONNECTOR_IDS entry, not just a hand-picked one', () => {
      for (const reserved of RESERVED_CONNECTOR_IDS) {
        const result = validateHostedServer(record({ id: reserved }));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/reserved/i);
      }
    });

    it('reuses CONNECTOR_ID_PATTERN rather than a second, potentially-drifted pattern', () => {
      // A handful of ids the pattern must treat identically either side of
      // the namespace: valid ones accepted, invalid ones refused, for the
      // SAME reason (the id shape check), not by coincidence.
      const candidates = ['abc', 'a-b-c', 'a__b', 'a b', '.abc', '-abc', ''];
      for (const id of candidates) {
        const patternSays = id.length > 0 && CONNECTOR_ID_PATTERN.test(id);
        const hostedResult = validateHostedServer(record({ id }));
        const connectorResult = validateConnector({ id, transport: 'stdio', command: '/bin/x' });
        // Both validators must agree with the pattern on shape, independent
        // of anything else either one separately checks (uniqueness,
        // reserved names, transport-specific fields).
        if (patternSays) {
          expect(hostedResult.ok || /already exists|reserved/i.test(hostedResult.error ?? '')).toBe(true);
          expect(connectorResult.ok || /already exists|reserved/i.test(connectorResult.error ?? '')).toBe(true);
        } else {
          expect(hostedResult.ok).toBe(false);
          expect(connectorResult.ok).toBe(false);
        }
      }
    });

    it('a connector id check against hosted ids as `existingIds` refuses the same way validateConnector already does for its own list', () => {
      // Increment 4 passes the UNION of connector ids and hosted ids into
      // both validators as `existingIds` — this proves the two validators
      // treat that union identically for the collision itself, which is the
      // property Increment 4 depends on.
      const union = ['files', 'hex'];
      expect(validateConnector({ id: 'files', transport: 'stdio', command: '/bin/x' }, union).ok).toBe(false);
      expect(validateHostedServer(record({ id: 'hex' }), union).ok).toBe(false);
    });
  });

  it('refuses a duplicate among the hosted server\'s own existingIds', () => {
    const result = validateHostedServer(record({ id: 'files' }), ['files', 'other']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists/i);
  });
});

/**
 * Increment 7's write gate (`docs/design/mcp-hosting.md`, the
 * DECISION (2026-08-13) block) is this one predicate, used by both
 * enforcement layers — `main/mcpHost/index.ts`'s `readyServersForAgent`
 * (Layer 1, the push filter) and `main/agentSession.ts`'s `handleMcpRelay`
 * (Layer 2, the actual boundary). Pinning it here, in isolation, is what
 * keeps the two layers from drifting into disagreeing about what "selected"
 * means — every other test that exercises either layer is exercising THIS
 * function underneath.
 */
describe('isToolSelected', () => {
  it('absent enabledTools means every tool is selected', () => {
    expect(isToolSelected(undefined, 'echo')).toBe(true);
    expect(isToolSelected(undefined, 'anything-at-all')).toBe(true);
  });

  it('an empty array means no tool is selected — NOT the same as absent', () => {
    expect(isToolSelected([], 'echo')).toBe(false);
    expect(isToolSelected([], 'anything-at-all')).toBe(false);
    // The two must be genuinely distinguishable, not just both "falsy" in some
    // other check — this is the exact collapse the decision block warns about.
    expect(isToolSelected(undefined, 'echo')).not.toBe(isToolSelected([], 'echo'));
  });

  it('a non-empty array selects only the named tools', () => {
    expect(isToolSelected(['echo'], 'echo')).toBe(true);
    expect(isToolSelected(['echo'], 'slow')).toBe(false);
    expect(isToolSelected(['echo', 'slow'], 'slow')).toBe(true);
    expect(isToolSelected(['echo', 'slow'], 'crash')).toBe(false);
  });
});

/**
 * R3 (`docs/design/mcp-hosting.md`): Increment 6.4 claims
 * `NODE_MODULE_VERSION` is "a constant we control". That is true only for
 * servers Acabox installed and launches itself — for a typed `npx …`,
 * `python` or `deno` command the interpreter, the ABI and the
 * download-on-every-start behaviour are all the user's.
 *
 * The derivation matters as much as the field: records written before the
 * field existed must not all silently become `acabox-node`, which would make
 * the app claim an ABI guarantee it does not have.
 */
describe('hostedRuntime', () => {
  const rec = (install: HostedInstallSource, runtime?: 'acabox-node' | 'system') =>
    ({ install, runtime }) as Pick<HostedMcpRecord, 'runtime' | 'install'>;

  it('returns the stored value when there is one', () => {
    expect(hostedRuntime(rec({ kind: 'custom' }, 'acabox-node'))).toBe('acabox-node');
    expect(hostedRuntime(rec({ kind: 'npm', pkg: 'p', version: '1.0.0' }, 'system'))).toBe('system');
  });

  it('derives acabox-node for everything Acabox installs and launches', () => {
    expect(hostedRuntime(rec({ kind: 'authored' }))).toBe('acabox-node');
    expect(hostedRuntime(rec({ kind: 'npm', pkg: 'p', version: '1.0.0' }))).toBe('acabox-node');
    expect(hostedRuntime(rec({ kind: 'github', repo: 'o/r', ref: 'a'.repeat(40) }))).toBe('acabox-node');
    expect(hostedRuntime(rec({ kind: 'catalog', catalogId: 'c' }))).toBe('acabox-node');
  });

  it('derives system for a command the user typed — the conservative direction', () => {
    // A typed command is the "works in Terminal, 127 from the Dock"
    // generator. Claiming `acabox-node` here would assert an ABI guarantee
    // that is simply not ours to make.
    expect(hostedRuntime(rec({ kind: 'custom' }))).toBe('system');
  });

  it('never returns undefined, for any install kind', () => {
    const kinds: HostedInstallSource[] = [
      { kind: 'custom' },
      { kind: 'catalog', catalogId: 'c' },
      { kind: 'npm', pkg: 'p', version: '1.0.0' },
      { kind: 'github', repo: 'o/r', ref: 'b'.repeat(40) },
      { kind: 'authored' },
    ];
    for (const k of kinds) {
      expect(['acabox-node', 'system']).toContain(hostedRuntime(rec(k)));
    }
  });
});
