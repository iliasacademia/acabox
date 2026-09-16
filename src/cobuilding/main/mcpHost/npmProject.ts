/**
 * Install one npm package into one directory, and find what to run.
 *
 * Increment 6a of `docs/design/mcp-hosting.md`. This is the genuinely new
 * capability in that increment: `packageInstaller.ts` holds the only other
 * npm call in all of `main/`, and it is unconditionally `-g --prefix` into a
 * SHARED site, while `containerService.exec` has no `cwd` option at all.
 * Neither can install one package into one server's own private tree, which
 * is what a hosted MCP server needs — two servers must be able to depend on
 * different versions of the same library without one clobbering the other.
 *
 * WHY npm AND NOT `npx`
 * --------------------
 * Every MCP server README says `npx -y <pkg>`. We deliberately do not do
 * that, for three measured reasons (R3 in the design doc): `npx` appears
 * nowhere in `main/` and is not on a GUI launch's PATH without
 * `getLoginShellPath()`; it execs the USER's Node, so `NODE_MODULE_VERSION`
 * stops being something we control; and it silently re-downloads code from
 * the network on every single start, which no disclosure copy in this app
 * mentions. Installing once and launching the resolved entry file under
 * `process.execPath` + `ELECTRON_RUN_AS_NODE=1` makes all three go away.
 *
 * WHY `--ignore-scripts`, AND WHAT IT COSTS
 * -----------------------------------------
 * Lifecycle scripts are arbitrary code executing at INSTALL time — before
 * the user has seen a single thing about what they installed, and before the
 * per-tool gate exists to refuse anything. Refusing them moves every line of
 * third-party execution to after the disclosure and the enable click.
 *
 * The cost is honest and is accepted rather than worked around: a package
 * with a native addon that builds from source will not build, because
 * `node-gyp` never runs. We do NOT then attempt a source build — that would
 * require Xcode Command Line Tools, which this repo treats as optional
 * (`build-dictation-helper.js`), so requiring them here would make installing
 * an MCP server fail on a machine where everything else works. A package
 * shipping a prebuilt binary for the wrong ABI fails at FIRST START instead,
 * where `diagnose.ts` turns it into a sentence. Same posture as
 * `packageInstaller`'s outright refusal of R.
 */

import log from 'electron-log';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNpmAvailable } from '../nodeSetup';
import { getLoginShellPath } from '../shellPath';

/** A line of installer output, for the live log pane (there is no percentage to report). */
export type LogSink = (line: string) => void;

export interface NpmInstallResult {
  /** The exact version that landed. Never a range — see `resolveExactVersion`. */
  version: string;
  /** `node_modules/<pkg>` inside the target dir. */
  packageDir: string;
  /** Absolute path to the JS entry file to run. */
  entryFile: string;
  /** From `npm ls --json`, when npm reports one. */
  integrity?: string;
}

/**
 * npm's own resolution, run to completion BEFORE anything is installed.
 *
 * A record must pin an exact version for the same reason `skillImporter`
 * resolves a ref to a 40-character SHA: "a pin recorded as a branch name is
 * not a pin", and `^1.2.0` / `latest` are branch names by another spelling.
 * Recording what the user typed would mean a "reproducible" install that
 * silently becomes different code on the next machine.
 */
export async function resolveExactVersion(
  npmBin: string,
  pkg: string,
  requested: string,
  onLog: LogSink,
): Promise<string> {
  const spec = requested && requested !== 'latest' ? `${pkg}@${requested}` : `${pkg}@latest`;
  onLog(`Resolving ${spec}…`);
  const { stdout } = await runNpm(npmBin, ['view', spec, 'version', '--json'], process.cwd(), onLog, { quiet: true });
  // `npm view … --json` yields `"1.2.3"` for one match and an ARRAY when the
  // range matches several — take the last, which is npm's own ordering's
  // newest. Parsed rather than regexed so a multi-match answer cannot be
  // silently truncated into a wrong pin.
  const parsed: unknown = JSON.parse(stdout.trim() || '""');
  const version = Array.isArray(parsed) ? String(parsed[parsed.length - 1] ?? '') : String(parsed ?? '');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`npm could not resolve ${spec} to a published version.`);
  }
  onLog(`Resolved to ${pkg}@${version}`);
  return version;
}

/**
 * Install `<pkg>@<version>` into `dir`, then resolve its entry file.
 *
 * `--prefix dir` with `--global false` is what puts `node_modules/` inside
 * this server's own directory. `--no-audit`/`--no-fund` only quiet output
 * that would otherwise dominate the log pane.
 */
export async function installNpmPackage(
  dir: string,
  pkg: string,
  version: string,
  onLog: LogSink,
): Promise<NpmInstallResult> {
  const npmBin = await ensureNpmAvailable();
  fs.mkdirSync(dir, { recursive: true });

  // A package.json must exist first or npm walks UPWARD looking for one and
  // can install into an ancestor — here, `<userData>/mcp-servers/`, shared by
  // every server. Found the hard way in packaging tools generally; cheap to
  // prevent, silently destructive to discover.
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      name: 'acabox-hosted-server', version: '0.0.0', private: true,
    }, null, 2), 'utf-8');
  }

  onLog(`Installing ${pkg}@${version}…`);
  await runNpm(npmBin, [
    'install', `${pkg}@${version}`,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix', dir,
  ], dir, onLog);

  const packageDir = path.join(dir, 'node_modules', ...pkg.split('/'));
  if (!fs.existsSync(packageDir)) {
    throw new Error(`npm reported success but ${pkg} is not in node_modules.`);
  }

  const entryFile = resolveEntryFile(packageDir, pkg);
  onLog(`Entry point: ${path.relative(dir, entryFile)}`);

  return { version, packageDir, entryFile, integrity: await readIntegrity(npmBin, dir, pkg, onLog) };
}

/**
 * What to actually execute, preferring the package's own `bin` over `main`.
 *
 * An MCP server is a COMMAND, so `bin` is the field that names its entry —
 * `main` is the library entry and for a server is frequently either absent or
 * a module that exports helpers and starts nothing. Getting this backwards
 * produces a process that exits 0 immediately and a "did not answer
 * initialize" error that points nowhere near the cause.
 *
 * `bin` is either a string (one command, named after the package) or an
 * object of name→path. With several, prefer the one whose name matches the
 * package's last path segment, else take the first — stated rather than left
 * to object key order.
 */
export function resolveEntryFile(packageDir: string, pkg: string): string {
  const manifestPath = path.join(packageDir, 'package.json');
  let manifest: { bin?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`${pkg} has no readable package.json: ${(err as Error).message}`);
  }

  const shortName = pkg.split('/').pop() as string;
  let rel: string | undefined;

  if (typeof manifest.bin === 'string') {
    rel = manifest.bin;
  } else if (manifest.bin && typeof manifest.bin === 'object') {
    const entries = Object.entries(manifest.bin as Record<string, string>);
    rel = (entries.find(([name]) => name === shortName) ?? entries[0])?.[1];
  }
  if (!rel && typeof manifest.main === 'string') rel = manifest.main;

  if (!rel) {
    throw new Error(`${pkg} declares neither "bin" nor "main", so there is nothing to run.`);
  }

  const resolved = path.join(packageDir, rel);
  if (!fs.existsSync(resolved)) {
    // By far the most likely way to reach here, and stating only the missing
    // path leaves the user with no idea why: a GitHub repo ships TypeScript
    // SOURCE, its `bin` points into a `dist/` that only exists after a build,
    // and Acabox does not run build scripts (`--ignore-scripts` — see this
    // module's header for why that is not negotiable). Measured against
    // modelcontextprotocol/servers@d73f99ef, whose `src/memory` fails exactly
    // this way. Say the cause, and say the way out.
    if (looksLikeUnbuiltSource(packageDir, rel)) {
      throw new Error(
        `This repository ships TypeScript source, and "${rel}" only exists after a build step. `
        + 'Acabox never runs a project’s build or install scripts, so it cannot produce it. '
        + 'Install this server from npm instead — the published package includes the built files.',
      );
    }
    throw new Error(`${pkg} points at "${rel}", which is not in the installed package.`);
  }
  return resolved;
}

/** Best effort — an absent integrity string is not a reason to fail an install. */
async function readIntegrity(npmBin: string, dir: string, pkg: string, onLog: LogSink): Promise<string | undefined> {
  try {
    const { stdout } = await runNpm(npmBin, ['ls', pkg, '--json', '--prefix', dir], dir, onLog, { quiet: true });
    const tree = JSON.parse(stdout) as { dependencies?: Record<string, { integrity?: string; resolved?: string }> };
    return tree.dependencies?.[pkg]?.integrity;
  } catch {
    return undefined;
  }
}

/**
 * One npm invocation, streaming both streams into the log pane.
 *
 * npm writes progress and warnings to stderr and is not failing when it does,
 * so stderr is logged like any other output rather than treated as an error —
 * only the exit code decides. PATH is the LOGIN shell's, because a
 * Finder-launched Acabox inherits launchd's PATH, which omits Homebrew and
 * nvm, i.e. where npm actually lives on most of these machines.
 */
function runNpm(
  npmBin: string,
  args: string[],
  cwd: string,
  onLog: LogSink,
  opts: { quiet?: boolean } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    if (!opts.quiet) onLog(`$ npm ${args.join(' ')}`);
    const child = execFile(npmBin, args, {
      cwd,
      env: { ...process.env, PATH: getLoginShellPath() },
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer | string) => {
      const text = String(d);
      stdout += text;
      if (!opts.quiet) for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line);
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      const text = String(d);
      stderr += text;
      if (!opts.quiet) for (const line of text.split(/\r?\n/)) if (line.trim()) onLog(line);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout });
      log.warn(`[McpHost] npm ${args[0]} exited ${code}`);
      // npm's own last words beat a generic "exit 1" — this string is what
      // `diagnose.ts` reads and what the user sees in the log pane.
      const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-4).join('\n');
      reject(new Error(tail || `npm ${args[0]} failed with exit code ${code}.`));
    });
  });
}

/**
 * Install a project's OWN declared dependencies, in its own directory.
 *
 * The GitHub path (6b) lands a source tree rather than a published package,
 * so there is nothing to `npm install <name>` — the deps are whatever its
 * `package.json` says. Same flags and the same refusal of lifecycle scripts
 * as `installNpmPackage`, for the same reasons.
 *
 * A tree with no `package.json`, or one with no dependencies, is not an
 * error: plenty of MCP servers are a single dependency-free file, which is
 * exactly what the `manage-mcp-server` scaffold produces.
 */
export async function installProjectDeps(dir: string, onLog: LogSink): Promise<void> {
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    onLog('No package.json — nothing to install.');
    return;
  }
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    throw new Error(`package.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!manifest.dependencies || Object.keys(manifest.dependencies).length === 0) {
    onLog('No runtime dependencies to install.');
    return;
  }

  const npmBin = await ensureNpmAvailable();
  onLog(`Installing ${Object.keys(manifest.dependencies).length} dependencies…`);
  await runNpm(npmBin, [
    'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir,
  ], dir, onLog);
}

/**
 * Does this tree look like un-built TypeScript rather than a broken package?
 *
 * Deliberately evidence-based rather than a guess from the extension alone:
 * the declared entry must point into a build output directory AND the tree
 * must actually carry TypeScript. A package with a genuinely stale `bin` and
 * no TS anywhere still gets the plain "not in the installed package" message,
 * which is the truthful one for it.
 */
function looksLikeUnbuiltSource(packageDir: string, rel: string): boolean {
  const pointsAtBuildOutput = /^\.?\/?(dist|build|lib|out)\//.test(rel.replace(/\\/g, '/'));
  if (!pointsAtBuildOutput) return false;
  if (fs.existsSync(path.join(packageDir, 'tsconfig.json'))) return true;
  try {
    const srcDir = path.join(packageDir, 'src');
    return fs.existsSync(srcDir) && fs.readdirSync(srcDir).some((f) => f.endsWith('.ts'));
  } catch {
    return false;
  }
}
