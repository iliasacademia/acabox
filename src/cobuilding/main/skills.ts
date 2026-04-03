import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const SKILL_NAMES = ['docx', 'pdf', 'pptx', 'xlsx'];

function getSkillsSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'skills');
  }
  return path.join(app.getAppPath(), 'src', 'cobuilding', 'skills');
}

export function copySkillsToWorkspace(workspaceDir: string): void {
  const sourceDir = getSkillsSourceDir();
  const targetDir = path.join(workspaceDir, '.claude', 'skills');

  for (const skill of SKILL_NAMES) {
    const src = path.join(sourceDir, skill);
    const dest = path.join(targetDir, skill);
    fs.cpSync(src, dest, { recursive: true });
  }
}
