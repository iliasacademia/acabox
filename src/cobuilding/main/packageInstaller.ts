import { EventEmitter } from 'events';
import log from 'electron-log';
import { containerService } from './containerService';
import { captureError } from '../shared/telemetry';
import { ensurePythonVenv, venvBin } from './pythonSetup';
import { getNpmPrefix, ensureNpmAvailable, NpmUnavailableError } from './nodeSetup';

/**
 * Strip the version suffix from an npm package spec. Handles scoped
 * packages (`@babel/core@7.28.5` → `@babel/core`) correctly — naive
 * `.split('@')[0]` would yield an empty string for those.
 */
function parseNpmName(spec: string): string {
  if (spec.startsWith('@')) {
    const at = spec.indexOf('@', 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf('@');
  return at === -1 ? spec : spec.slice(0, at);
}

/**
 * Package-level install coordinator.
 *
 * Tools request their deps via `ensureDeps`. Packages are de-duplicated across
 * tools so the same wheel is never downloaded twice in a session. Within a
 * registry, installs are serialized into "waves" (one `pip install pkg1 pkg2`
 * command per wave) because pip/apt/R can't safely write to the same env from
 * multiple processes. Different registries run in parallel because they touch
 * different layers (pip ≠ apt ≠ R ≠ manual scripts).
 *
 * A short coalescing window before a wave starts lets multiple tools opened
 * in quick succession get batched into one install command.
 */

export type Registry = 'pip' | 'npm' | 'R' | 'apt' | 'manual';
export type PackageState = 'queued' | 'installing' | 'installed' | 'failed';

export interface InstallRequest {
  registry: Registry;
  // For pip/R/apt: package names. For npm: `name@version`. For manual: script
  // paths (each "package" is a script).
  packages: string[];
}

const REGISTRIES: Registry[] = ['pip', 'npm', 'R', 'apt', 'manual'];

// How long to wait after a package is queued before kicking off a wave, so
// multiple tools requesting in quick succession get batched.
const COALESCING_MS = 200;

// Max frequency at which per-package line events cross the IPC boundary.
// pip's progress ticks can fire many times per second; the renderer doesn't
// benefit from more than a few updates per second per package.
const PACKAGE_LINE_THROTTLE_MS = 150;

interface Resolver {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PackageMatcher {
  pkg: string;
  lowerName: string;
  re: RegExp;
}

class PackageInstaller extends EventEmitter {
  private states: Record<Registry, Map<string, PackageState>>;
  // Most recent line emitted per package, so a renderer that subscribes
  // mid-wave can seed its status text from the snapshot rather than waiting
  // for the next matching line (which for slow downloads may never come
  // until the wave finishes).
  private lastLines: Record<Registry, Map<string, string>>;
  // Concurrent in-flight waves per registry. pip/npm allow multiple waves to
  // run in parallel (so a small new install doesn't wait for a big in-flight
  // one). apt/R/manual stay serialized — apt has dpkg-lock, R is fragile
  // under concurrency, and manual scripts are independent side-effecting
  // units that can't be safely interleaved.
  private currentWaves: Record<Registry, Set<string[]>>;
  private pending: Record<Registry, Set<string>>;
  private coalesceTimers: Record<Registry, ReturnType<typeof setTimeout> | null>;
  // Per-package promise; multiple ensureDeps callers waiting on the same
  // package share the same resolver.
  private resolvers: Record<Registry, Map<string, Resolver>>;
  private promises: Record<Registry, Map<string, Promise<void>>>;
  // Bumped on reset(). A wave records its generation at start; if generation
  // changes before the wave's finally runs, the wave is "stale" and must not
  // pollute the post-reset state.
  private generation = 0;

  constructor() {
    super();
    this.states = {} as typeof this.states;
    this.lastLines = {} as typeof this.lastLines;
    this.currentWaves = {} as typeof this.currentWaves;
    this.pending = {} as typeof this.pending;
    this.coalesceTimers = {} as typeof this.coalesceTimers;
    this.resolvers = {} as typeof this.resolvers;
    this.promises = {} as typeof this.promises;
    for (const r of REGISTRIES) {
      this.states[r] = new Map();
      this.lastLines[r] = new Map();
      this.currentWaves[r] = new Set();
      this.pending[r] = new Set();
      this.coalesceTimers[r] = null;
      this.resolvers[r] = new Map();
      this.promises[r] = new Map();
    }
  }

  private isSerialized(registry: Registry): boolean {
    return registry === 'apt' || registry === 'R' || registry === 'manual';
  }

  /**
   * Resolves once every requested package reaches `installed`. Rejects if
   * any requested package fails.
   */
  async ensureDeps(requests: InstallRequest[]): Promise<void> {
    const waitFor: Promise<void>[] = [];

    for (const req of requests) {
      const { registry, packages } = req;
      if (packages.length === 0) continue;

      for (const pkg of packages) {
        const state = this.states[registry].get(pkg);
        if (state === 'installed') continue;

        let promise = this.promises[registry].get(pkg);
        if (!promise) {
          promise = new Promise<void>((resolve, reject) => {
            this.resolvers[registry].set(pkg, { resolve, reject });
          });
          this.promises[registry].set(pkg, promise);
        }
        waitFor.push(promise);

        // If a wave is already installing this package, our resolver shares
        // its promise. Otherwise add to pending so the next wave picks it up.
        if (state !== 'installing' && !this.pending[registry].has(pkg)) {
          this.transition(registry, pkg, 'queued');
          this.pending[registry].add(pkg);
          this.scheduleWave(registry);
        }
      }
    }

    await Promise.all(waitFor);
  }

  getPackageStates(): Record<Registry, Record<string, PackageState>> {
    const out = {} as Record<Registry, Record<string, PackageState>>;
    for (const r of REGISTRIES) {
      out[r] = Object.fromEntries(this.states[r]);
    }
    return out;
  }

  getPackageLines(): Record<Registry, Record<string, string>> {
    const out = {} as Record<Registry, Record<string, string>>;
    for (const r of REGISTRIES) {
      out[r] = Object.fromEntries(this.lastLines[r]);
    }
    return out;
  }

  /**
   * Reset all install state. Called when the container stops/restarts so the
   * fresh /opt/venv isn't mistakenly treated as having everything installed.
   * In-flight wave promises are rejected so callers don't hang.
   */
  reset(): void {
    this.generation++;
    for (const r of REGISTRIES) {
      this.states[r].clear();
      this.lastLines[r].clear();
      this.currentWaves[r].clear();
      this.pending[r].clear();
      if (this.coalesceTimers[r]) {
        clearTimeout(this.coalesceTimers[r]);
        this.coalesceTimers[r] = null;
      }
      const err = new Error('Container restarted; install state reset');
      for (const resolver of this.resolvers[r].values()) {
        resolver.reject(err);
      }
      this.resolvers[r].clear();
      this.promises[r].clear();
    }
    this.emit('reset');
  }

  // ─── Wave coordination ───────────────────────────────────────

  private scheduleWave(registry: Registry): void {
    // Serialized registries gate on existing wave; parallel ones (pip, npm)
    // always schedule, so a new install can run alongside an in-flight one.
    if (this.isSerialized(registry) && this.currentWaves[registry].size > 0) return;
    if (this.coalesceTimers[registry]) return;
    this.coalesceTimers[registry] = setTimeout(() => {
      this.coalesceTimers[registry] = null;
      this.startWave(registry);
    }, COALESCING_MS);
  }

  private async startWave(registry: Registry): Promise<void> {
    if (this.isSerialized(registry) && this.currentWaves[registry].size > 0) return;
    if (this.pending[registry].size === 0) return;

    // Manual scripts run one per wave (each is an independent bash script and
    // can't be merged). The next pending manual starts via scheduleWave from
    // the finally-block once this one resolves.
    const allPending = Array.from(this.pending[registry]);
    const packages = registry === 'manual' ? [allPending[0]] : allPending;
    for (const pkg of packages) this.pending[registry].delete(pkg);
    this.currentWaves[registry].add(packages);

    for (const pkg of packages) this.transition(registry, pkg, 'installing');

    log.info(`[PackageInstaller] ${registry} wave start: ${packages.join(', ')}`);

    // Record the generation at start. If reset() bumps generation while we're
    // awaiting runWave, this wave is stale and must not touch post-reset
    // state when its finally runs.
    const startGen = this.generation;

    let waveError: Error | null = null;
    try {
      await this.runWave(registry, packages);
    } catch (err) {
      waveError = err instanceof Error ? err : new Error(String(err));
      log.warn(`[PackageInstaller] ${registry} wave failed: ${waveError.message}`);
      captureError(err, {
        subsystem: 'package_install',
        extra: { registry, package_count: packages.length },
      });
    } finally {
      this.currentWaves[registry].delete(packages);

      if (this.generation !== startGen) {
        log.debug(`[PackageInstaller] ${registry} wave (gen ${startGen}) discarded after reset to gen ${this.generation}`);
        return;
      }

      // Resolve / reject every package in the wave. Packages that the line
      // parser already transitioned to `installed` stay installed — they're
      // genuinely in the target env (pip confirmed it) and a later wave
      // failure doesn't retroactively un-install them. Anything still
      // `installing` flips to `installed` on success or `failed` on error.
      for (const pkg of packages) {
        const currentState = this.states[registry].get(pkg);
        const alreadyInstalled = currentState === 'installed';
        if (waveError) {
          if (!alreadyInstalled) this.transition(registry, pkg, 'failed');
        } else if (!alreadyInstalled) {
          this.transition(registry, pkg, 'installed');
        }
        const r = this.resolvers[registry].get(pkg);
        if (r) {
          if (waveError && !alreadyInstalled) r.reject(waveError);
          else r.resolve();
          this.resolvers[registry].delete(pkg);
          this.promises[registry].delete(pkg);
        }
      }

      if (this.pending[registry].size > 0) {
        this.scheduleWave(registry);
      }
    }
  }

  private async runWave(registry: Registry, packages: string[]): Promise<void> {
    // Pip needs the venv to exist. Lazy-bootstrap on first use so the heavy
    // setup only runs when someone actually requests a Python package.
    if (registry === 'pip') {
      try { await ensurePythonVenv(); }
      catch (err) {
        throw new Error(`Python environment not available: ${(err as Error).message}`);
      }
    }
    // npm needs to be on the user's PATH. Probe up-front so a missing Node
    // install produces an actionable error instead of an ENOENT mid-wave.
    if (registry === 'npm') {
      try { await ensureNpmAvailable(); }
      catch (err) {
        if (err instanceof NpmUnavailableError) {
          throw new Error('npm is not installed. Install Node.js (https://nodejs.org or "brew install node") and try again.');
        }
        throw err;
      }
    }
    const command = this.buildCommand(registry, packages);
    log.info(`[PackageInstaller] ${registry} wave running: ${command.join(' ')}`);

    // Build per-package matchers once per wave. Pip emits 100s-1000s of lines
    // (download progress ticks), so compiling regexes per-line per-package was
    // measurably wasteful.
    const matchers = this.buildPackageMatchers(registry, packages);
    const lowerNames = new Map(matchers.map((m) => [m.lowerName, m.pkg]));

    // Throttle per-package `line` events: pip's progress ticks can fire many
    // times per second, and each event triggers IPC + setState fanout to
    // every subscribed renderer. Keep only the latest line per package and
    // flush at most every PACKAGE_LINE_THROTTLE_MS.
    const pendingLines = new Map<string, string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingLines = () => {
      flushTimer = null;
      for (const [pkg, line] of pendingLines) {
        this.emit('package:line', { registry, package: pkg, line });
      }
      pendingLines.clear();
    };
    const queuePackageLine = (pkg: string, line: string) => {
      pendingLines.set(pkg, line);
      this.lastLines[registry].set(pkg, line);
      if (!flushTimer) {
        flushTimer = setTimeout(flushPendingLines, PACKAGE_LINE_THROTTLE_MS);
      }
    };

    try {
      const { exitCode } = await containerService.execStreaming(command, (line) => {
        this.handleLine(registry, matchers, lowerNames, queuePackageLine, line);
      });
      log.info(`[PackageInstaller] ${registry} wave exited with code ${exitCode} (packages: ${packages.join(', ')})`);
      if (exitCode !== 0) {
        throw new Error(`${registry} install exited with code ${exitCode}`);
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      flushPendingLines();
    }
  }

  private buildPackageMatchers(registry: Registry, packages: string[]): PackageMatcher[] {
    return packages.map((pkg) => {
      const name = registry === 'npm' ? parseNpmName(pkg) : pkg;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        pkg,
        lowerName: name.toLowerCase(),
        re: new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`, 'i'),
      };
    });
  }

  // ─── Command construction ────────────────────────────────────

  private buildCommand(registry: Registry, packages: string[]): string[] {
    switch (registry) {
      case 'pip':
        // Install into the user-data venv that backs both the agent's
        // python invocations and the kernel gateway. No `--target`: regular
        // venv install so packages are importable from `python` inside the
        // venv without any sys.path tweaking.
        return [venvBin('pip'), 'install', '--disable-pip-version-check', '--no-input', ...packages];
      case 'npm':
        // Host-side shared install. mini-apps reach these modules at build
        // time via NODE_PATH=<npmPrefix>/lib/node_modules; we set that env
        // in the esbuild invocation that bundles the iframe.
        return ['npm', 'install', '-g', '--prefix', getNpmPrefix(), '--no-audit', '--no-fund', ...packages];
      case 'R':
      case 'apt':
        // R and apt installs were container-only. On a host build we don't
        // own the system package manager, so refuse with a clear message
        // rather than silently no-op.
        throw new Error(`${registry} installs are not supported on host. Install the dependency manually and re-open the app.`);
      case 'manual':
        if (packages.length !== 1) {
          // Manual scripts can't be batched — they're side-effecting bash
          // scripts. The scheduler should only queue one per wave.
          throw new Error(`Manual wave requires exactly one script, got ${packages.length}`);
        }
        return ['bash', packages[0]];
    }
    const _exhaustive: never = registry;
    throw new Error(`Unhandled registry: ${_exhaustive}`);
  }

  // ─── Line attribution ────────────────────────────────────────

  private handleLine(
    registry: Registry,
    matchers: PackageMatcher[],
    lowerNames: Map<string, string>,
    queuePackageLine: (pkg: string, line: string) => void,
    line: string,
  ): void {
    if (registry === 'pip') {
      const { packages, isSuccess, isProgressLine } = this.parsePipLine(lowerNames, line);
      if (packages.length > 0) {
        for (const pkg of packages) queuePackageLine(pkg, line);
        if (isSuccess) {
          for (const pkg of packages) {
            log.info(`[PackageInstaller] success matched pip/${pkg}: ${line}`);
            this.transition('pip', pkg, 'installed');
            const r = this.resolvers.pip.get(pkg);
            if (r) {
              r.resolve();
              this.resolvers.pip.delete(pkg);
              this.promises.pip.delete(pkg);
            }
          }
        }
      } else if (isProgressLine) {
        // Transitive-dep line (e.g. "Downloading nvidia_nccl_cu13-..."). Surface
        // it on every wave package still installing so the UI shows continuous
        // progress instead of hanging on the last subject-named line.
        for (const m of matchers) {
          if (this.states.pip.get(m.pkg) === 'installing') {
            queuePackageLine(m.pkg, line);
          }
        }
      }
      return;
    }

    // For non-pip registries the broad-mention regex is fine — apt/R/manual
    // output rarely embeds dep-tree chatter.
    for (const m of matchers) {
      if (m.re.test(line)) queuePackageLine(m.pkg, line);
    }
  }

  /**
   * Parse a pip output line. Only attributes to packages that appear in the
   * SUBJECT position — not inside `(from X->...)` dep-tree clauses.
   *
   * `isProgressLine` is true for any recognized pip activity verb (Collecting /
   * Downloading / Using cached) even when no subject package matches, so the
   * caller can surface transitive-dep work to in-wave packages.
   */
  private parsePipLine(
    lowerNames: Map<string, string>,
    line: string,
  ): { packages: string[]; isSuccess: boolean; isProgressLine: boolean } {
    let m: RegExpMatchArray | null;

    // "Successfully installed name-1.0.0 name2-2.0.0 ..."
    m = line.match(/^Successfully installed\s+(.+)$/);
    if (m) {
      const result: string[] = [];
      for (const token of m[1].split(/\s+/)) {
        const tm = token.match(/^([\w.+-]+?)-(\d[\w.+-]*)$/);
        const name = tm?.[1];
        if (!name) continue;
        const matched = lowerNames.get(name.toLowerCase());
        if (matched && !result.includes(matched)) result.push(matched);
      }
      return { packages: result, isSuccess: true, isProgressLine: false };
    }

    // "Requirement already satisfied: name[==1.0] in /path"  — only the
    // subject name (right after the colon) counts. Anything inside "(from ...)"
    // is dep-tree, which we deliberately ignore.
    m = line.match(/^Requirement already satisfied:\s+([^\s<>=!~()]+)/);
    if (m) {
      const matched = lowerNames.get(m[1].toLowerCase());
      return { packages: matched ? [matched] : [], isSuccess: matched != null, isProgressLine: false };
    }

    // "Collecting name", "Collecting name>=1.0"
    m = line.match(/^Collecting\s+([\w.+-]+)/);
    if (m) {
      const matched = lowerNames.get(m[1].toLowerCase());
      return { packages: matched ? [matched] : [], isSuccess: false, isProgressLine: true };
    }

    // "Downloading name-version.whl..." or "  Downloading name-version.whl"
    m = line.match(/^\s*Downloading\s+([\w.+]+?)-\d/);
    if (m) {
      const matched = lowerNames.get(m[1].toLowerCase());
      return { packages: matched ? [matched] : [], isSuccess: false, isProgressLine: true };
    }

    // "Using cached name-version.whl"
    m = line.match(/^\s*Using cached\s+([\w.+]+?)-\d/);
    if (m) {
      const matched = lowerNames.get(m[1].toLowerCase());
      return { packages: matched ? [matched] : [], isSuccess: false, isProgressLine: true };
    }

    // "Installing collected packages: name, name, ..."
    m = line.match(/^Installing collected packages:\s+(.+)$/);
    if (m) {
      const result: string[] = [];
      for (const name of m[1].split(/[,\s]+/)) {
        if (!name) continue;
        const matched = lowerNames.get(name.toLowerCase());
        if (matched && !result.includes(matched)) result.push(matched);
      }
      return { packages: result, isSuccess: false, isProgressLine: false };
    }

    return { packages: [], isSuccess: false, isProgressLine: false };
  }

  // ─── State transitions ───────────────────────────────────────

  private transition(registry: Registry, pkg: string, state: PackageState): void {
    const prev = this.states[registry].get(pkg);
    if (prev === state) return;
    this.states[registry].set(pkg, state);
    log.debug(`[PackageInstaller] ${registry}/${pkg}: ${prev ?? 'unknown'} → ${state}`);
    this.emit('package:state', { registry, package: pkg, state });
  }
}

export const packageInstaller = new PackageInstaller();

/**
 * Convert the raw InstallStep[] (from environmentGenerator) into
 * InstallRequest[] keyed by the installer's package identity. For manual
 * scripts, the identity is the full bash path so two apps with the same
 * script name in different dirs don't accidentally dedup.
 */
export function installStepsToRequests(
  steps: Array<{ registry: string; packages: string[] }>,
  dirName: string,
): InstallRequest[] {
  return steps
    .filter((s): s is { registry: Registry; packages: string[] } =>
      (REGISTRIES as string[]).includes(s.registry))
    .map((step) => {
      if (step.registry === 'manual') {
        return {
          registry: 'manual' as Registry,
          packages: step.packages.map((s) => `.applications/${dirName}/setup/${s}`),
        };
      }
      return { registry: step.registry, packages: step.packages };
    });
}
