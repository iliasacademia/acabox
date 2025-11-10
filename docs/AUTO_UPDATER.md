# Auto-Updater Implementation

This document describes the auto-updater implementation for Academia Electron App, including how to use it, how to create releases, and how the update feed server works.

## Overview

The app uses `electron-updater` to automatically check for and install updates from GitHub Releases. Updates are distributed through two channels:
- **Stable**: Production-ready releases
- **Beta**: Early access releases with new features

## Architecture

### Components

1. **electron-updater**: Core library that handles update checking, downloading, and installation
2. **GitHub Releases**: Serves as the update feed server (no custom server needed)
3. **Timestamp-based versioning**: Versions use format `YYYYMMDDHHMMSS[-beta]`
4. **electron-store**: Persists user's channel preference
5. **GitHub Actions**: Automated build and release pipeline

### Version Format

Versions use timestamps for guaranteed chronological ordering:
- **Stable**: `20250106143022` (14 digits: YYYYMMDDHHMMSS)
- **Beta**: `20250106143022-beta` (timestamp + `-beta` suffix)

Example:
- Version `20250106143022` = Built on January 6, 2025 at 14:30:22 UTC
- Displayed to users as: "Jan 6, 2025 14:30 UTC"

## How It Works

### For End Users

1. **Automatic Check**: App checks for updates 10 seconds after launch (only in production)
2. **User Notification**: If update available, shows dialog with version info
3. **User Choice**: User can download now or postpone
4. **Download**: If user approves, update downloads in background with progress logging
5. **Installation Prompt**: When download complete, prompts user to restart
6. **Installation**: On restart, update is automatically installed

### Update Flow

```
App Launch
    ↓
setupAutoUpdater() (10 second delay)
    ↓
Check GitHub Releases for latest version in user's channel
    ↓
Version Available? ───NO──→ Continue normal operation
    ↓ YES
Show "Update Available" dialog to user
    ↓
User clicks "Download"? ───NO──→ Continue normal operation
    ↓ YES
Download update in background
    ↓
Show "Update Ready" dialog
    ↓
User clicks "Restart Now"? ───NO──→ Install on next app quit
    ↓ YES
Quit and install immediately
```

### Channel Management

Users can switch channels via the tray menu:
1. Right-click tray icon
2. Select "Update Channel" → "Stable" or "Beta"
3. App displays confirmation dialog
4. Channel preference saved to electron-store
5. Next update check uses new channel

## Creating Releases

### Step 1: Create Git Tag

For **Stable Release**:
```bash
git tag v-stable-$(date -u +%Y%m%d%H%M%S)
git push origin --tags
```

For **Beta Release**:
```bash
git tag v-beta-$(date -u +%Y%m%d%H%M%S)
git push origin --tags
```

### Step 2: GitHub Actions Workflow

The workflow automatically:
1. Generates timestamp version
2. Detects channel from git tag (`-beta` suffix)
3. Updates `package.json` version
4. Builds native modules
5. Packages application (creates `.zip` and `.dmg`)
6. Signs and notarizes (macOS)
7. Publishes to GitHub Releases

### Step 3: Release is Published

The release is automatically created with:
- **Title**: "Release YYYYMMDDHHMMSS" or "Beta Release YYYYMMDDHHMMSS"
- **Assets**:
  - `Academia-darwin-x64-YYYYMMDDHHMMSS.zip` (for auto-updater)
  - `Academia-darwin-x64-YYYYMMDDHHMMSS.dmg` (for manual download)
  - `latest-mac.yml` (auto-generated update manifest)
- **Prerelease flag**: `true` for beta, `false` for stable
- **Body**: Version, channel, and build date information

## Feed Server (GitHub Releases)

### How electron-updater Uses GitHub Releases

1. **Configuration** (in `main.ts`):
   ```typescript
   autoUpdater.setFeedURL({
     provider: 'github',
     owner: 'academia-edu',
     repo: 'academia-electron',
   });
   autoUpdater.channel = 'stable'; // or 'beta'
   ```

2. **Update Check**: electron-updater fetches:
   ```
   https://github.com/academia-edu/academia-electron/releases/download/latest/latest-mac.yml
   ```

3. **Manifest Contents** (`latest-mac.yml`):
   ```yaml
   version: 20250106143022
   releaseDate: '2025-01-06T14:30:22.000Z'
   files:
     - url: Academia-darwin-x64-20250106143022.zip
       sha512: [checksum]
       size: 123456789
   path: Academia-darwin-x64-20250106143022.zip
   sha512: [checksum]
   releaseNotes: [from GitHub release body]
   ```

4. **Version Comparison**: Compares timestamp strings (newer timestamp = newer version)

5. **Download**: If update available, downloads `.zip` file

6. **Verification**: Verifies SHA512 checksum before installation

### Channel Separation

- **Stable channel**: Fetches latest non-prerelease
- **Beta channel**: Fetches latest prerelease with `-beta` tag

GitHub Releases API automatically handles this based on the `prerelease` flag.

## Files Modified

- `src/main.ts`: Auto-updater logic, event handlers, menu items, IPC handlers
- `forge.config.js`: Added GitHub publisher configuration
- `.github/workflows/build.yml`: Added version generation and publishing steps
- `scripts/generate-version.sh`: Version generation script
- `package.json`: Added `electron-updater` dependency

## Configuration

### Update Settings (electron-store)

Stored in `~/Library/Application Support/academia-electron/config.json`:
```json
{
  "updateChannel": "stable"
}
```

### Environment Variables

- `UPDATE_CHANNEL`: Override channel (optional, mainly for testing)
- `APPLE_ID`: Apple ID for notarization (GitHub Actions secret)
- `APPLE_ID_PASSWORD`: App-specific password (GitHub Actions secret)
- `APPLE_TEAM_ID`: Apple Team ID (GitHub Actions secret)

## IPC Handlers

Available for renderer process:

- `get-update-channel`: Returns current channel ('stable' or 'beta')
- `set-update-channel`: Changes channel preference
- `get-app-version`: Returns version and formatted version string

Example usage:
```typescript
const channel = await window.electronAPI.invoke('get-update-channel');
await window.electronAPI.invoke('set-update-channel', 'beta');
const { version, formatted } = await window.electronAPI.invoke('get-app-version');
```

## Testing

### Test Update Flow Locally

1. Build and package app:
   ```bash
   npm run package
   ```

2. Open packaged app (not via `npm start`)

3. Auto-updater will check for updates after 10 seconds

4. Check console logs for update events

### Test Manual Update Check

1. Launch packaged app
2. Right-click tray icon
3. Select "Check for Updates..."
4. Dialog appears (update available or not)

### Test Channel Switching

1. Launch packaged app
2. Right-click tray icon → "Update Channel" → "Beta"
3. Confirmation dialog appears
4. Restart app
5. Next update check uses beta channel

## Troubleshooting

### Updates Not Working

1. **Check if packaged**: Auto-updater only works in packaged app (`app.isPackaged === true`)
2. **Check logs**: Look for `[Auto-Updater]` prefix in console
3. **Check GitHub Releases**: Verify releases exist and are published (not draft)
4. **Check channel**: Verify correct channel is selected in tray menu
5. **Check version**: Ensure current version is older than available version

### Version Comparison Issues

Timestamps are compared as strings, which works because:
- Format: `YYYYMMDDHHMMSS` (14 digits)
- Lexicographic comparison equals chronological order
- Example: `"20250106143022" > "20250105120000"` ✓

### Manual Testing

To test without waiting for real releases:
1. Temporarily lower the app version in `package.json`
2. Build and package
3. Create a newer test release on GitHub
4. Launch packaged app and check for updates

## Security

- **HTTPS only**: GitHub enforces HTTPS for all downloads
- **Code signing**: All releases are signed with Apple Developer certificate
- **Notarization**: macOS apps are notarized by Apple
- **Checksum verification**: SHA512 hashes verified before installation
- **Rollback safety**: electron-updater won't downgrade to older versions

## Future Enhancements

Possible improvements:
- Progress bar for download in UI
- Release notes display in update dialog
- Update history/changelog viewer
- Differential updates (delta patches)
- Automatic retry on network failure
- Update scheduling (install at specific time)
