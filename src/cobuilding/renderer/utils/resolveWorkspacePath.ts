/**
 * Resolve a potentially-relative file path to an absolute host path.
 *
 * Scanned files and container-produced paths use the directory basename as the
 * first segment (e.g. `Testing/paper.docx` when the user directory is
 * `/Users/.../Testing`). This strips the redundant prefix so the path
 * resolves to the correct absolute location on the host.
 */
export function resolveWorkspacePath(
  filePath: string,
  agentDir: string,
  userDirPaths: string[],
): string {
  if (filePath.startsWith('/')) return filePath;

  for (const dir of userDirPaths) {
    const basename = dir.split('/').pop();
    if (basename && filePath.startsWith(basename + '/')) {
      return `${dir}/${filePath.slice(basename.length + 1)}`;
    }
  }

  if (userDirPaths.length > 0) return `${userDirPaths[0]}/${filePath}`;
  return `${agentDir}/${filePath}`;
}
