import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function getCobuildingSourceDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(app.getAppPath(), 'src', 'cobuilding');
}

export function copySkillsToWorkspace(workspaceDir: string): void {
  const skillsSourceDir = path.join(getCobuildingSourceDir(), 'skills');
  const targetDir = path.join(workspaceDir, '.claude', 'skills');

  const skillNames = fs.readdirSync(skillsSourceDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => /^[a-zA-Z0-9-_]+$/.test(name));

  for (const skill of skillNames) {
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
}

export function copyClaudeMdToWorkspace(workspaceDir: string): void {
  const sourceDir = getCobuildingSourceDir();
  const src = path.join(sourceDir, 'CLAUDE.md');
  const dest = path.join(workspaceDir, '.claude', 'CLAUDE.md');

  fs.mkdirSync(path.join(workspaceDir, '.claude'), { recursive: true });
  fs.cpSync(src, dest);
}
