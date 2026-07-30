/**
 * Workspace-relative paths under .academia/.
 *
 * Both the agent-server (Podman container, workspace root = /data) and the
 * directory scanner (Electron main process, workspace root = directoryPath)
 * join these with their own workspace root to reach the same physical location.
 */

export const WORKSPACE_DATA_DIR = 'workspace-data';

// Arbitrary upper bound on user directories per workspace.
export const MAX_WORKSPACE_DIRECTORIES = 10;

export const ACADEMIA_DIR = '.academia';
export const APPLICATIONS_DIR = '.applications';
export const CLAUDE_DIR = '.claude';

// Durable per-tool data root. A mini-app's working files (inputs/outputs) live
// under `tool-data/<dirName>/` while its code lives under `.applications/<dirName>/`.
// The code dir's `input`/`output` entries are symlinks into here, so deleting a
// tool (removing `.applications/<dirName>/`) leaves its data untouched.
export const TOOL_DATA_DIR = 'tool-data';
export const TOOL_DATA_SUBDIRS = ['input', 'output'] as const;

export const AGENT_MEMORY_DIR = 'agent-memory';
export const AGENT_MEMORY_SUBDIR = `${ACADEMIA_DIR}/${AGENT_MEMORY_DIR}`;

export const MEMORY_FILE_ABOUT_YOU = 'about_you.md';
export const MEMORY_FILE_WORKING_ON = 'working_on.md';

// The CLI's own index for the memory directory. It is loaded unconditionally on
// every turn (tagged `AutoMem`), so it is the one file here whose contents are
// always in context — every other memory is reached only through a link in it.
// That makes "is this file listed in MEMORY.md?" a real, checkable property of
// a memory rather than a cosmetic one, which is why the Knowledge page shows it.
export const MEMORY_INDEX_FILE = 'MEMORY.md';

export const MEMORY_PATH_ABOUT_YOU = `${AGENT_MEMORY_DIR}/${MEMORY_FILE_ABOUT_YOU}`;
export const MEMORY_PATH_WORKING_ON = `${AGENT_MEMORY_DIR}/${MEMORY_FILE_WORKING_ON}`;

export const REFERENCES_DIR = 'references';
export const REFERENCES_SUBDIR = `${ACADEMIA_DIR}/${REFERENCES_DIR}`;
export const REFERENCES_INDEX = 'index.json';

export const SOUL_MD = 'SOUL.md';
export const FOCUS_MD = 'FOCUS.md';
