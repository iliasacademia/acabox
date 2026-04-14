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

function cpSyncWithRetry(src: string, dest: string, maxRetries = 5): void {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      fs.cpSync(src, dest, { recursive: true });
      return;
    } catch (err: any) {
      if (err.code === 'EINTR' && attempt < maxRetries) {
        continue;
      }
      throw err;
    }
  }
}

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
    cpSyncWithRetry(src, dest);
  }
}

export function syncMiniAppAssets(workspaceDir: string): void {
  const skillsSourceDir = path.join(getCobuildingSourceDir(), 'skills');
  const assetsDir = path.join(skillsSourceDir, 'manage-mini-application', 'assets');
  const appsDir = path.join(workspaceDir, '.applications');

  const bridgeSrc = path.join(assetsDir, 'bridge');
  const bridgeDest = path.join(appsDir, '_bridge');
  cpSyncWithRetry(bridgeSrc, bridgeDest);

  const vendorSrc = path.join(assetsDir, 'vendor');
  if (fs.existsSync(vendorSrc)) {
    const vendorDest = path.join(appsDir, '_vendor');
    cpSyncWithRetry(vendorSrc, vendorDest);
  }

  const templatesSrc = path.join(assetsDir, 'templates');
  if (fs.existsSync(templatesSrc)) {
    const templatesDest = path.join(appsDir, '_templates');
    cpSyncWithRetry(templatesSrc, templatesDest);
  }

  const reusableSrc = path.join(assetsDir, 'reusable');
  if (fs.existsSync(reusableSrc)) {
    const reusableDest = path.join(appsDir, '_reusable');
    cpSyncWithRetry(reusableSrc, reusableDest);
  }
}

export function copyClaudeMdToWorkspace(workspaceDir: string): void {
  const sourceDir = getCobuildingSourceDir();
  const src = path.join(sourceDir, 'CLAUDE.md');
  const dest = path.join(workspaceDir, '.claude', 'CLAUDE.md');

  fs.mkdirSync(path.join(workspaceDir, '.claude'), { recursive: true });
  fs.cpSync(src, dest);
}
