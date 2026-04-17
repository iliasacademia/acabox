import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function getCobuildingSourceDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(app.getAppPath(), 'src', 'cobuilding');
}

const SKILLS = [
  'activity-summary',
  'alphafold-database-access',
  'database-lookup',
  'differential-expression',
  'docx',
  'ensembl-database',
  'geo-database',
  'gnomad-database',
  'manage-mini-application',
  'opentargets-database',
  'pdb-database',
  'pdf',
  'pptx',
  'react-plotly',
  'reaction',
  'reactome-database',
  'review-manuscript',
  'string-database-ppi',
  'xlsx',
];

export function copySkillsToWorkspace(workspaceDir: string): void {
  const skillsSourceDir = path.join(getCobuildingSourceDir(), 'skills');
  const targetDir = path.join(workspaceDir, '.claude', 'skills');

  // Remove skills in the workspace that are no longer in SKILLS
  if (fs.existsSync(targetDir)) {
    const existing = fs.readdirSync(targetDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    for (const name of existing) {
      if (!SKILLS.includes(name)) {
        fs.rmSync(path.join(targetDir, name), { recursive: true, force: true });
      }
    }
  }

  for (const skill of SKILLS) {
    const src = path.join(skillsSourceDir, skill);
    const dest = path.join(targetDir, skill);
    fs.cpSync(src, dest, { recursive: true });
  }
}

export function syncMiniAppAssets(workspaceDir: string): void {
  const skillsSourceDir = path.join(getCobuildingSourceDir(), 'skills');
  const assetsDir = path.join(skillsSourceDir, 'manage-mini-application', 'assets');
  const appsDir = path.join(workspaceDir, '.applications');

  const bridgeSrc = path.join(assetsDir, 'bridge');
  const bridgeDest = path.join(appsDir, '_bridge');
  fs.cpSync(bridgeSrc, bridgeDest, { recursive: true });

  const vendorSrc = path.join(assetsDir, 'vendor');
  if (fs.existsSync(vendorSrc)) {
    const vendorDest = path.join(appsDir, '_vendor');
    fs.cpSync(vendorSrc, vendorDest, { recursive: true });
  }

  const templatesSrc = path.join(assetsDir, 'templates');
  if (fs.existsSync(templatesSrc)) {
    const templatesDest = path.join(appsDir, '_templates');
    fs.cpSync(templatesSrc, templatesDest, { recursive: true });
  }

  const reusableSrc = path.join(assetsDir, 'reusable');
  if (fs.existsSync(reusableSrc)) {
    const reusableDest = path.join(appsDir, '_reusable');
    fs.cpSync(reusableSrc, reusableDest, { recursive: true });
  }

  // Install wrapper: the only sanctioned way for the agent to install software.
  // We always overwrite from source and verify the copy landed + is executable.
  const installSrc = path.join(assetsDir, 'install');
  const installDest = path.join(appsDir, 'install');
  fs.mkdirSync(appsDir, { recursive: true });
  fs.cpSync(installSrc, installDest);
  fs.chmodSync(installDest, 0o755);
}

/**
 * Copy Claude Code settings.json into the workspace. This wires up the
 * PreToolUse hook that blocks host-side pip/npm/apt-get/Rscript invocations
 * and points the agent at the install wrapper instead.
 */
export function copyClaudeSettingsToWorkspace(workspaceDir: string): void {
  const sourceDir = getCobuildingSourceDir();
  const src = path.join(sourceDir, 'settings.json');
  const claudeDir = path.join(workspaceDir, '.claude');
  const dest = path.join(claudeDir, 'settings.json');

  fs.mkdirSync(claudeDir, { recursive: true });
  fs.cpSync(src, dest);
}

/**
 * Copy hook scripts into .claude/hooks/ in the workspace. These are referenced
 * by settings.json. We overwrite on every startup so the scripts stay in sync
 * with the shipped version and can't be tampered with.
 */
export function copyHooksToWorkspace(workspaceDir: string): void {
  const sourceDir = getCobuildingSourceDir();
  const hooksSrc = path.join(sourceDir, 'hooks');
  if (!fs.existsSync(hooksSrc)) return;

  const hooksDest = path.join(workspaceDir, '.claude', 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  fs.cpSync(hooksSrc, hooksDest, { recursive: true });

  // Ensure every .sh in the hooks directory is executable.
  for (const entry of fs.readdirSync(hooksDest)) {
    if (entry.endsWith('.sh')) {
      fs.chmodSync(path.join(hooksDest, entry), 0o755);
    }
  }
}

export function copyClaudeMdToWorkspace(workspaceDir: string): void {
  const sourceDir = getCobuildingSourceDir();
  const src = path.join(sourceDir, 'CLAUDE.md');
  const dest = path.join(workspaceDir, '.claude', 'CLAUDE.md');

  fs.mkdirSync(path.join(workspaceDir, '.claude'), { recursive: true });
  fs.cpSync(src, dest);
}

/** Provision all workspace files in one call. */
export function provisionWorkspace(workspaceDir: string): void {
  copySkillsToWorkspace(workspaceDir);
  copyClaudeMdToWorkspace(workspaceDir);
  copyClaudeSettingsToWorkspace(workspaceDir);
  copyHooksToWorkspace(workspaceDir);
  syncMiniAppAssets(workspaceDir);
}
