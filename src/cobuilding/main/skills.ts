import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const SKILL_NAMES = ['docx', 'pdf', 'pptx', 'xlsx', 'differential-expression', 'activity-summary'];

function getCobuildingSourceDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(app.getAppPath(), 'src', 'cobuilding');
}

export function copySkillsToWorkspace(workspaceDir: string): void {
  const skillsSourceDir = path.join(getCobuildingSourceDir(), 'skills');
  const targetDir = path.join(workspaceDir, '.claude', 'skills');

  for (const skill of SKILL_NAMES) {
    const src = path.join(skillsSourceDir, skill);
    const dest = path.join(targetDir, skill);
    fs.cpSync(src, dest, { recursive: true });
  }
}

export function copyClaudeMdToWorkspace(workspaceDir: string): void {
  const sourceDir = getCobuildingSourceDir();
  const src = path.join(sourceDir, 'CLAUDE.md');
  const dest = path.join(workspaceDir, '.claude', 'CLAUDE.md');

  fs.mkdirSync(path.join(workspaceDir, '.claude'), { recursive: true });
  fs.cpSync(src, dest);
}
