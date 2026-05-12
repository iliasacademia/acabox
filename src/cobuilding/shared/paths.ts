/**
 * Workspace-relative paths under .academia/.
 *
 * Both the agent-server (Podman container, workspace root = /data) and the
 * directory scanner (Electron main process, workspace root = directoryPath)
 * join these with their own workspace root to reach the same physical location.
 */

export const AGENT_MEMORY_SUBDIR = '.academia/agent-memory';
