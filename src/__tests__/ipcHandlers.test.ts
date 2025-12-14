/**
 * Tests to ensure IPC handlers are not duplicated
 *
 * Electron's ipcMain.handle() throws an error if a handler is registered twice
 * for the same channel. This test scans main.ts to detect duplicates at build time.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('IPC Handler Registration', () => {
  test('should not have duplicate ipcMain.handle() registrations', () => {
    const mainTsPath = path.join(__dirname, '..', 'main.ts');
    const mainTsContent = fs.readFileSync(mainTsPath, 'utf-8');

    // Match ipcMain.handle() calls with string literals or IPC_CHANNELS references
    // Patterns:
    // - ipcMain.handle('channel-name', ...)
    // - ipcMain.handle("channel-name", ...)
    // - ipcMain.handle(IPC_CHANNELS.CHANNEL_NAME, ...)
    const handleRegex = /ipcMain\.handle\(\s*(?:(['"`])([^'"`]+)\1|IPC_CHANNELS\.(\w+))/g;

    const channels: string[] = [];
    const channelLocations: Map<string, number[]> = new Map();

    let match;
    while ((match = handleRegex.exec(mainTsContent)) !== null) {
      // match[2] is the channel name from string literal
      // match[3] is the constant name from IPC_CHANNELS
      const channel = match[2] || `IPC_CHANNELS.${match[3]}`;
      channels.push(channel);

      // Track line numbers for better error messages
      const lineNumber = mainTsContent.substring(0, match.index).split('\n').length;
      if (!channelLocations.has(channel)) {
        channelLocations.set(channel, []);
      }
      channelLocations.get(channel)!.push(lineNumber);
    }

    // Find duplicates
    const duplicates = channels.filter((channel, index) => channels.indexOf(channel) !== index);

    if (duplicates.length > 0) {
      const duplicateInfo = [...new Set(duplicates)].map(channel => {
        const lines = channelLocations.get(channel);
        return `  - "${channel}" registered at lines: ${lines?.join(', ')}`;
      }).join('\n');

      fail(`Duplicate IPC handlers found:\n${duplicateInfo}\n\nElectron will throw "Attempted to register a second handler" error at runtime.`);
    }

    expect(duplicates).toHaveLength(0);
  });

  test('should resolve IPC_CHANNELS constants to detect cross-reference duplicates', () => {
    const mainTsPath = path.join(__dirname, '..', 'main.ts');
    const typesPath = path.join(__dirname, '..', 'shared', 'types.ts');

    const mainTsContent = fs.readFileSync(mainTsPath, 'utf-8');
    const typesContent = fs.readFileSync(typesPath, 'utf-8');

    // Extract IPC_CHANNELS constant values from types.ts
    const channelConstantRegex = /(\w+):\s*['"`]([^'"`]+)['"`]/g;
    const constantToValue: Map<string, string> = new Map();

    let constMatch;
    while ((constMatch = channelConstantRegex.exec(typesContent)) !== null) {
      constantToValue.set(constMatch[1], constMatch[2]);
    }

    // Match all ipcMain.handle() calls
    const handleRegex = /ipcMain\.handle\(\s*(?:(['"`])([^'"`]+)\1|IPC_CHANNELS\.(\w+))/g;

    const resolvedChannels: string[] = [];
    const channelSources: Map<string, { source: string; line: number }[]> = new Map();

    let match;
    while ((match = handleRegex.exec(mainTsContent)) !== null) {
      let resolvedChannel: string;
      let source: string;

      if (match[2]) {
        // Direct string literal
        resolvedChannel = match[2];
        source = `'${match[2]}'`;
      } else {
        // IPC_CHANNELS constant
        const constantName = match[3];
        resolvedChannel = constantToValue.get(constantName) || `UNKNOWN_${constantName}`;
        source = `IPC_CHANNELS.${constantName}`;
      }

      resolvedChannels.push(resolvedChannel);

      const lineNumber = mainTsContent.substring(0, match.index).split('\n').length;
      if (!channelSources.has(resolvedChannel)) {
        channelSources.set(resolvedChannel, []);
      }
      channelSources.get(resolvedChannel)!.push({ source, line: lineNumber });
    }

    // Find duplicates after resolving constants
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const channel of resolvedChannels) {
      if (seen.has(channel)) {
        duplicates.push(channel);
      }
      seen.add(channel);
    }

    if (duplicates.length > 0) {
      const duplicateInfo = [...new Set(duplicates)].map(channel => {
        const sources = channelSources.get(channel);
        const sourceInfo = sources?.map(s => `${s.source} (line ${s.line})`).join(', ');
        return `  - Channel "${channel}" registered via: ${sourceInfo}`;
      }).join('\n');

      fail(`Duplicate IPC handlers found (after resolving IPC_CHANNELS constants):\n${duplicateInfo}\n\nThis includes handlers using both string literals and IPC_CHANNELS constants that resolve to the same channel name.`);
    }

    expect(duplicates).toHaveLength(0);
  });
});
