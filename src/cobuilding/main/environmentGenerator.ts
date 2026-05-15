/**
 * Environment Generator
 *
 * Scans all app directories under .applications/, reads their per-registry
 * dependency files, and merges/dedupes them. Used by the debug panel and
 * live dependency installer.
 */

import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';

// ─── Types ─────────────────────────────────────────────────────

export interface AppDeps {
  appName: string;
  pipPackages: string[];
  npmDependencies: Record<string, string>;
  rPackages: string[];
  aptPackages: string[];
  setupScripts: string[]; // filenames under setup/
}

export interface MergedEnvironment {
  pipRequirements: string[];
  npmPackages: string[]; // "name@version" lines
  rPackages: string[];
  aptPackages: string[];
  setupScripts: { sourcePath: string; destName: string }[];
}

export interface EnvironmentInfo {
  apps: AppDeps[];
  merged: MergedEnvironment;
  hasAnyDeps: boolean;
}

function mergedHasDeps(merged: MergedEnvironment): boolean {
  return (
    merged.pipRequirements.length > 0 ||
    merged.npmPackages.length > 0 ||
    merged.rPackages.length > 0 ||
    merged.aptPackages.length > 0 ||
    merged.setupScripts.length > 0
  );
}

/** Check if an AppDeps has any dependencies at all. */
export function appHasDeps(deps: AppDeps): boolean {
  return (
    deps.pipPackages.length > 0 ||
    Object.keys(deps.npmDependencies).length > 0 ||
    deps.rPackages.length > 0 ||
    deps.aptPackages.length > 0 ||
    deps.setupScripts.length > 0
  );
}

type ExecFn = (command: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
type StreamingExecFn = (command: string[], onLine: (line: string) => void) => Promise<{ exitCode: number }>;

export interface InstallStep {
  registry: string;
  packages: string[];
  command: string[];
}

/** Build the list of install steps for an app's deps without executing them. */
export function getInstallSteps(appsDir: string, dirName: string): InstallStep[] {
  const deps = readAppDeps(appsDir, dirName);
  if (!appHasDeps(deps)) return [];

  const steps: InstallStep[] = [];

  if (deps.pipPackages.length > 0) {
    steps.push({
      registry: 'pip',
      packages: deps.pipPackages,
      command: ['sh', '-c', 'PIP=$(command -v /opt/venv/bin/pip || command -v pip3 || echo pip) && exec $PIP install --no-input ' + deps.pipPackages.join(' ')],
    });
  }

  const npmPkgs = Object.entries(deps.npmDependencies).map(([n, v]) => `${n}@${v}`);
  if (npmPkgs.length > 0) {
    steps.push({
      registry: 'npm',
      packages: npmPkgs,
      command: ['npm', 'install', '-g', ...npmPkgs],
    });
  }

  if (deps.rPackages.length > 0) {
    // Sanitize R package names to prevent injection into the Rscript -e string
    const safeRPkgs = deps.rPackages.map((p) => p.replace(/[^a-zA-Z0-9._]/g, ''));
    const vec = 'c(' + safeRPkgs.map((p) => `"${p}"`).join(',') + ')';
    steps.push({
      registry: 'R',
      packages: deps.rPackages,
      command: ['Rscript', '-e', `install.packages(${vec}, repos='https://cloud.r-project.org')`],
    });
  }

  if (deps.aptPackages.length > 0) {
    // Sanitize apt package names to prevent shell injection
    const safeAptPkgs = deps.aptPackages.map((p) => p.replace(/[^a-zA-Z0-9._+\-:]/g, ''));
    steps.push({
      registry: 'apt',
      packages: deps.aptPackages,
      command: ['bash', '-lc', `apt-get update && apt-get install -y ${safeAptPkgs.join(' ')}`],
    });
  }

  for (const script of deps.setupScripts) {
    steps.push({
      registry: 'manual',
      packages: [script],
      command: ['bash', `.applications/${dirName}/setup/${script}`],
    });
  }

  return steps;
}

/**
 * Install an app's deps live in a running container. Idempotent — already-installed
 * packages are fast no-ops. Returns a summary of what was installed.
 */
export async function installDepsInContainer(
  appsDir: string,
  dirName: string,
  exec: ExecFn,
): Promise<string[]> {
  const steps = getInstallSteps(appsDir, dirName);
  const results: string[] = [];
  for (const step of steps) {
    results.push(`${step.registry}: ${step.packages.length} packages`);
    await exec(step.command);
  }
  return results;
}

/**
 * Like installDepsInContainer but streams output lines as they arrive.
 * Calls onProgress before each step with the registry and package list,
 * and onLine for each output line during execution.
 */
export async function installDepsStreaming(
  appsDir: string,
  dirName: string,
  execStreaming: StreamingExecFn,
  onProgress: (registry: string, packages: string[]) => void,
  onLine: (line: string) => void,
): Promise<string[]> {
  const steps = getInstallSteps(appsDir, dirName);
  const results: string[] = [];
  for (const step of steps) {
    results.push(`${step.registry}: ${step.packages.length} packages`);
    onProgress(step.registry, step.packages);
    await execStreaming(step.command, onLine);
  }
  return results;
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Scan all app directories, merge deps, write _environment/, return hash.
 * Idempotent — safe to call multiple times. Overwrites _environment/ each time.
 */
/**
 * Read-only: scan apps and compute what the environment looks like.
 * Used by the debug panel to show current state.
 */
export function getEnvironmentInfo(workspacePath: string): EnvironmentInfo {
  const appsDir = path.join(workspacePath, '.applications');

  const apps = discoverApps(appsDir);
  const allDeps = apps.map((app) => readAppDeps(appsDir, app));
  const merged = mergeDeps(allDeps);

  return { apps: allDeps, merged, hasAnyDeps: mergedHasDeps(merged) };
}

// ─── Internal (exported for testing) ───────────────────────────

/** List non-system app directories under .applications/. */
export function discoverApps(appsDir: string): string[] {
  if (!fs.existsSync(appsDir)) return [];

  return fs
    .readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      if (entry.name.startsWith('_')) return false; // system dirs
      return true;
    })
    .map((entry) => entry.name)
    .sort();
}

/** Read all dependency files for one app. */
export function readAppDeps(appsDir: string, appName: string): AppDeps {
  const appDir = path.join(appsDir, appName);
  const deps: AppDeps = {
    appName,
    pipPackages: [],
    npmDependencies: {},
    rPackages: [],
    aptPackages: [],
    setupScripts: [],
  };

  const reqsPath = path.join(appDir, 'requirements.txt');
  if (fs.existsSync(reqsPath)) {
    deps.pipPackages = readLines(reqsPath);
  }

  const pkgJsonPath = path.join(appDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      deps.npmDependencies = pkg.dependencies ?? {};
    } catch (err) {
      log.warn(`[EnvironmentGenerator] Malformed package.json in ${appName}: ${(err as Error).message}`);
    }
  }

  const rPath = path.join(appDir, 'r-packages.txt');
  if (fs.existsSync(rPath)) {
    deps.rPackages = readLines(rPath);
  }

  const aptPath = path.join(appDir, 'apt-packages.txt');
  if (fs.existsSync(aptPath)) {
    deps.aptPackages = readLines(aptPath);
  }
  const setupDir = path.join(appDir, 'setup');
  if (fs.existsSync(setupDir)) {
    deps.setupScripts = fs
      .readdirSync(setupDir)
      .filter((f) => f.endsWith('.sh'))
      .sort();
  }

  return deps;
}

/** Merge dependencies from all apps into a single environment. */
export function mergeDeps(allDeps: AppDeps[]): MergedEnvironment {
  // pip: dedupe by base package name, last app wins
  const pipMap = new Map<string, string>(); // baseName -> full spec
  for (const app of allDeps) {
    for (const pkg of app.pipPackages) {
      const baseName = pipBaseName(pkg);
      if (pipMap.has(baseName) && pipMap.get(baseName) !== pkg) {
        log.warn(
          `[EnvironmentGenerator] pip conflict for "${baseName}": ` +
            `"${pipMap.get(baseName)}" -> "${pkg}" (from ${app.appName})`,
        );
      }
      pipMap.set(baseName, pkg);
    }
  }
  const pipRequirements = [...pipMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, spec]) => spec);

  // npm: merge dependencies, last app wins on conflict
  const npmMap = new Map<string, string>(); // name -> version
  for (const app of allDeps) {
    for (const [name, version] of Object.entries(app.npmDependencies)) {
      if (npmMap.has(name) && npmMap.get(name) !== version) {
        log.warn(
          `[EnvironmentGenerator] npm conflict for "${name}": ` +
            `"${npmMap.get(name)}" -> "${version}" (from ${app.appName})`,
        );
      }
      npmMap.set(name, version);
    }
  }
  const npmPackages = [...npmMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => `${name}@${version}`);

  // R: set union, sorted
  const rSet = new Set<string>();
  for (const app of allDeps) {
    for (const pkg of app.rPackages) rSet.add(pkg);
  }
  const rPackages = [...rSet].sort();

  // apt: set union, sorted
  const aptSet = new Set<string>();
  for (const app of allDeps) {
    for (const pkg of app.aptPackages) aptSet.add(pkg);
  }
  const aptPackages = [...aptSet].sort();

  // setup scripts: rename to <app>--<script> for stable ordering and provenance
  const setupScripts: MergedEnvironment['setupScripts'] = [];
  for (const app of allDeps) {
    for (const script of app.setupScripts) {
      setupScripts.push({
        sourcePath: path.join(app.appName, 'setup', script),
        destName: `${app.appName}--${script}`,
      });
    }
  }
  setupScripts.sort((a, b) => a.destName.localeCompare(b.destName));

  return { pipRequirements, npmPackages, rPackages, aptPackages, setupScripts };
}

// ─── Helpers ───────────────────────────────────────────────────

/** Read a text file into non-empty, non-comment lines. */
function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Extract the base package name from a pip spec (strip version specifiers). */
function pipBaseName(spec: string): string {
  return spec.replace(/[<>=!~;[\s].*/s, '').toLowerCase();
}

