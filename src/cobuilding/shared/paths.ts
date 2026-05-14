/**
 * Workspace-relative paths under .academia/.
 *
 * Both the agent-server (Podman container, workspace root = /data) and the
 * directory scanner (Electron main process, workspace root = directoryPath)
 * join these with their own workspace root to reach the same physical location.
 */

export const WORKSPACE_DATA_DIR = 'workspace-data';

export const ACADEMIA_DIR = '.academia';
export const APPLICATIONS_DIR = '.applications';
export const CLAUDE_DIR = '.claude';

export const AGENT_MEMORY_DIR = 'agent-memory';
export const AGENT_MEMORY_SUBDIR = `${ACADEMIA_DIR}/${AGENT_MEMORY_DIR}`;

export const MEMORY_FILE_ABOUT_YOU = 'about_you.md';
export const MEMORY_FILE_WORKING_ON = 'working_on.md';

export const MEMORY_PATH_ABOUT_YOU = `${AGENT_MEMORY_DIR}/${MEMORY_FILE_ABOUT_YOU}`;
export const MEMORY_PATH_WORKING_ON = `${AGENT_MEMORY_DIR}/${MEMORY_FILE_WORKING_ON}`;

export const SOUL_MD = 'SOUL.md';
export const FOCUS_MD = 'FOCUS.md';
