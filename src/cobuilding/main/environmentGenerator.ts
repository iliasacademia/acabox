/**
 * Environment Generator
 *
 * Scans all app directories under .applications/, reads their per-registry
 * dependency files, merges/dedupes them, writes the merged result to
 * .applications/_environment/, and generates a Dockerfile.user that installs
 * everything on top of the base image.
 *
 * The _environment/ directory serves double duty:
 *   1. Build context for `podman build`
 *   2. Human-readable manifest for the debug panel
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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

export interface GenerateResult {
  environmentDir: string;
  dockerfilePath: string;
  hash: string;
  hasAnyDeps: boolean;
}

export interface EnvironmentInfo {
  apps: AppDeps[];
  merged: MergedEnvironment;
  environmentHash: string | null;
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
      command: ['/opt/venv/bin/pip', 'install', '--no-input', ...deps.pipPackages],
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
export function generateEnvironment(workspacePath: string, baseImage: string): GenerateResult {
  const appsDir = path.join(workspacePath, '.applications');
  const envDir = path.join(appsDir, '_environment');

  const apps = discoverApps(appsDir);
  const allDeps = apps.map((app) => readAppDeps(appsDir, app));
  const merged = mergeDeps(allDeps);

  const dockerfile = generateDockerfile(merged, baseImage);

  writeEnvironmentFiles(envDir, merged, appsDir);
  fs.writeFileSync(path.join(envDir, 'Dockerfile.user'), dockerfile);

  const hash = computeEnvironmentHash(envDir);
  const hasAnyDeps = mergedHasDeps(merged);

  return {
    environmentDir: envDir,
    dockerfilePath: path.join(envDir, 'Dockerfile.user'),
    hash,
    hasAnyDeps,
  };
}

/**
 * Read-only: scan apps and compute what the environment looks like without
 * writing anything. Used by the debug panel to show current state.
 */
export function getEnvironmentInfo(workspacePath: string): EnvironmentInfo {
  const appsDir = path.join(workspacePath, '.applications');
  const envDir = path.join(appsDir, '_environment');

  const apps = discoverApps(appsDir);
  const allDeps = apps.map((app) => readAppDeps(appsDir, app));
  const merged = mergeDeps(allDeps);

  let environmentHash: string | null = null;
  if (fs.existsSync(envDir) && fs.existsSync(path.join(envDir, 'Dockerfile.user'))) {
    environmentHash = computeEnvironmentHash(envDir);
  }

  return { apps: allDeps, merged, environmentHash, hasAnyDeps: mergedHasDeps(merged) };
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

/** Write merged dependency files to _environment/. */
export function writeEnvironmentFiles(
  envDir: string,
  merged: MergedEnvironment,
  appsDir: string,
): void {
  // Clean and recreate
  fs.rmSync(envDir, { recursive: true, force: true });
  fs.mkdirSync(envDir, { recursive: true });

  if (merged.pipRequirements.length > 0) {
    fs.writeFileSync(path.join(envDir, 'requirements.txt'), merged.pipRequirements.join('\n') + '\n');
  }

  if (merged.npmPackages.length > 0) {
    fs.writeFileSync(path.join(envDir, 'npm-packages.txt'), merged.npmPackages.join('\n') + '\n');
  }

  if (merged.rPackages.length > 0) {
    fs.writeFileSync(path.join(envDir, 'r-packages.txt'), merged.rPackages.join('\n') + '\n');
  }

  if (merged.aptPackages.length > 0) {
    fs.writeFileSync(path.join(envDir, 'apt-packages.txt'), merged.aptPackages.join('\n') + '\n');
  }

  if (merged.setupScripts.length > 0) {
    const setupDir = path.join(envDir, 'setup');
    fs.mkdirSync(setupDir, { recursive: true });
    for (const script of merged.setupScripts) {
      const src = path.join(appsDir, script.sourcePath);
      const dest = path.join(setupDir, script.destName);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
  }
}

/** Generate Dockerfile.user content. Only includes sections with packages. */
export function generateDockerfile(merged: MergedEnvironment, baseImage: string): string {
  const lines: string[] = [
    '# Auto-generated by environment generator. Do not edit.',
    `ARG BASE_IMAGE=${baseImage}`,
    'FROM ${BASE_IMAGE}',
    '',
    '# Ensure the Python kernel spec uses the venv python (absolute path).',
    '# podman exec and kernel gateway subprocesses do not inherit the ENV PATH',
    '# set during the base image build, so a bare "python" resolves to the',
    '# system Python which lacks ipykernel and user-installed packages.',
    'RUN KSPEC=/opt/venv/share/jupyter/kernels/python3/kernel.json && \\',
    '    if [ -f "$KSPEC" ]; then \\',
    '      sed -i \'s|"python"|"/opt/venv/bin/python"|g\' "$KSPEC"; \\',
    '    fi',
    '',
  ];

  if (merged.aptPackages.length > 0) {
    lines.push(
      '# --- apt packages ---',
      'COPY apt-packages.txt /tmp/apt-packages.txt',
      'RUN apt-get update && xargs -a /tmp/apt-packages.txt apt-get install -y && rm -rf /var/lib/apt/lists/*',
      '',
    );
  }

  if (merged.pipRequirements.length > 0) {
    lines.push(
      '# --- pip packages ---',
      'COPY requirements.txt /tmp/requirements.txt',
      'RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt',
      '',
    );
  }

  if (merged.npmPackages.length > 0) {
    lines.push(
      '# --- npm packages ---',
      'COPY npm-packages.txt /tmp/npm-packages.txt',
      'RUN xargs -a /tmp/npm-packages.txt npm install -g',
      '',
    );
  }

  if (merged.rPackages.length > 0) {
    lines.push(
      '# --- R packages ---',
      'COPY r-packages.txt /tmp/r-packages.txt',
      "RUN Rscript -e \"pkgs <- readLines('/tmp/r-packages.txt'); install.packages(pkgs, repos='https://cloud.r-project.org')\"",
      '',
    );
  }

  if (merged.setupScripts.length > 0) {
    lines.push(
      '# --- setup scripts ---',
      'COPY setup/ /tmp/setup/',
      'RUN for s in /tmp/setup/*.sh; do bash "$s"; done',
      '',
    );
  }

  lines.push('WORKDIR /data', '');

  return lines.join('\n');
}

/** Compute SHA256 hash of all files in envDir, sorted by relative path. */
export function computeEnvironmentHash(envDir: string): string {
  const hash = crypto.createHash('sha256');
  const files = listFilesRecursive(envDir).sort();

  for (const relPath of files) {
    const content = fs.readFileSync(path.join(envDir, relPath));
    hash.update(relPath);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }

  return hash.digest('hex').substring(0, 16);
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

/** Recursively list all files in a directory, returning relative paths. */
function listFilesRecursive(dir: string, prefix = ''): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(path.join(dir, entry.name), relPath));
    } else {
      results.push(relPath);
    }
  }

  return results;
}
