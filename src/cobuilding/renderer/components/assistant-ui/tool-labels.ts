function basename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function truncate(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\u2026';
}

export function getToolLabel(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsText?: string,
): string {
  let resolved = args && Object.keys(args).length > 0 ? args : undefined;
  if (!resolved && argsText) {
    try {
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object') {
        resolved = parsed as Record<string, unknown>;
      }
    } catch {
      // argsText is incomplete JSON during streaming
    }
  }

  switch (toolName) {
    case 'Bash': {
      const desc = resolved?.description as string | undefined;
      if (desc) return desc;
      const cmd = resolved?.command as string | undefined;
      if (cmd) return truncate(cmd);
      return 'Running command';
    }
    case 'Read': {
      const fp = resolved?.file_path as string | undefined;
      return fp ? `Reading ${basename(fp)}` : 'Reading file';
    }
    case 'Write': {
      const fp = resolved?.file_path as string | undefined;
      return fp ? `Writing ${basename(fp)}` : 'Writing file';
    }
    case 'ToolSearch':
      return 'Searching tools';
    case 'Edit': {
      const fp = resolved?.file_path as string | undefined;
      return fp ? `Editing ${basename(fp)}` : 'Editing file';
    }
    case 'Glob': {
      const pattern = resolved?.pattern as string | undefined;
      return pattern ? `Searching files: ${pattern}` : 'Searching files';
    }
    case 'Grep': {
      const pattern = resolved?.pattern as string | undefined;
      return pattern ? `Searching for: ${truncate(pattern)}` : 'Searching code';
    }
    case 'Agent': {
      const desc = resolved?.description as string | undefined;
      return desc || 'Running sub-agent';
    }
    case 'NotebookEdit': {
      const fp = resolved?.notebook_path as string | undefined;
      return fp ? `Editing notebook: ${basename(fp)}` : 'Editing notebook';
    }
    case 'WebSearch': {
      const query = resolved?.query as string | undefined;
      return query ? `Searching web: ${truncate(query)}` : 'Searching web';
    }
    case 'Skill': {
      const skill = resolved?.skill as string | undefined;
      return skill ? `Running skill: ${skill}` : 'Running skill';
    }
    case 'TodoWrite':
      return 'Updating tasks';
    case 'mcp__activity__query_activity':
      return 'Querying activity';
    case 'mcp__mini-apps__open_mini_application': {
      const dirName = resolved?.dir_name as string | undefined;
      return dirName ? `Opening app: ${dirName}` : 'Opening app';
    }
    default:
      return toolName;
  }
}
