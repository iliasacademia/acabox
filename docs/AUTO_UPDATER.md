# Auto-Updater Implementation

This document describes the auto-updater implementation for Academia Electron App, including how to use it, how to create releases, and how the update feed server works.

## Overview

The app uses `electron-updater` to automatically check for and install updates from S3 + CloudFront. Updates are distributed through two channels:
- **Stable**: Production-ready releases
- **Beta**: Early access releases with new features

## Architecture

### Components

1. **electron-updater**: Core library that handles update checking, downloading, and installation
2. **AWS S3**: Private storage for application artifacts and update manifests
3. **AWS CloudFront**: CDN for fast, global distribution of updates
4. **Timestamp-based versioning**: Versions use format `MAJOR.MINOR.YYYYMMDDHHMMSS[-beta]`
5. **electron-store**: Persists user's channel preference
6. **GitHub Actions**: Automated build and release pipeline
7. **GitHub Releases**: Backup distribution for manual downloads

### Version Format

Versions use semantic versioning with timestamps for guaranteed chronological ordering:
- **Stable**: `0.0.20250106143022` (MAJOR.MINOR.YYYYMMDDHHMMSS)
- **Beta**: `0.0.20250106143022-beta` (MAJOR.MINOR.YYYYMMDDHHMMSS-beta)

Example:
- Version `0.0.20250106143022` = Built on January 6, 2025 at 14:30:22 UTC
- Displayed to users as: "Jan 6, 2025 14:30 UTC"

The MAJOR.MINOR prefix allows for semantic versioning while the timestamp patch ensures chronological ordering.

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
Check CloudFront for latest-mac.yml in user's channel
(https://CLOUDFRONT-DOMAIN/stable/ or /beta/)
    ↓
Version Available? ───NO──→ Continue normal operation
    ↓ YES
Show "Update Available" dialog to user
    ↓
User clicks "Download"? ───NO──→ Continue normal operation
    ↓ YES
Download update from S3 via CloudFront
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

### Step 1: Push to Main Branch or Feature Branch

**For Stable Release** (main branch):
```bash
git checkout main
git pull
# Make your changes
git commit -m "Your changes"
git push origin main
```

**For Beta Release** (feature branch):
```bash
git checkout -b feature/your-feature
# Make your changes
git commit -m "Your changes"
git push origin feature/your-feature
```

### Step 2: GitHub Actions Workflow

The workflow automatically:
1. Generates semantic version with timestamp (e.g., `0.0.20250110123456`)
2. Detects channel from branch:
   - `main` branch → stable channel
   - Other branches → beta channel (adds `-beta` suffix)
3. Updates `package.json` version
4. Builds native modules
5. Packages application (creates `.zip` and `.dmg`)
6. Signs and notarizes (macOS)
7. **Uploads to S3**:
   - Uploads artifacts to `s3://BUCKET/CHANNEL/VERSION/`
   - Modifies and uploads `latest-mac.yml` to `s3://BUCKET/CHANNEL/`
8. **Invalidates CloudFront cache** for `latest-mac.yml`
9. Creates GitHub Release (backup for manual downloads)

### Step 3: S3 Structure After Release

The S3 bucket structure looks like this:
```
qa-academia-electron-artifacts/
├── stable/
│   ├── latest-mac.yml (points to latest version)
│   ├── 0.0.20250110123456/
│   │   ├── Academia-darwin-x64-0.0.20250110123456.zip
│   │   ├── Academia-darwin-x64-0.0.20250110123456.dmg
│   │   └── Academia-darwin-x64-0.0.20250110123456.zip.blockmap
│   └── 0.0.20250109100000/
│       └── (previous version preserved)
└── beta/
    ├── latest-mac.yml
    └── 0.0.20250110123456-beta/
        └── (artifacts)
```

**Benefits of versioned folders:**
- History preserved for rollback
- Multiple versions available simultaneously
- Easy to debug update issues

## Feed Server (S3 + CloudFront)

### How electron-updater Uses S3 + CloudFront

1. **Configuration** (in `main.ts`):
   ```typescript
   const cloudfrontDomain = 'YOUR-CLOUDFRONT-DOMAIN.cloudfront.net';
   autoUpdater.setFeedURL({
     provider: 'generic',
     url: `https://${cloudfrontDomain}/${channel}`,
   });
   ```

2. **Update Check**: electron-updater fetches:
   ```
   https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/latest-mac.yml
   # or
   https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/beta/latest-mac.yml
   ```

3. **Manifest Contents** (`latest-mac.yml`):
   ```yaml
   version: 0.0.20250106143022
   releaseDate: '2025-01-06T14:30:22.000Z'
   files:
     - url: https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip
       sha512: [checksum]
       size: 123456789
   path: https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip
   sha512: [checksum]
   releaseNotes: [optional]
   ```

4. **Version Comparison**: Compares semantic version strings with timestamp patch

5. **Download**: If update available, downloads `.zip` file from CloudFront/S3

6. **Verification**: Verifies SHA512 checksum before installation

### Channel Separation

- **Stable channel**: URL points to `https://CLOUDFRONT-DOMAIN/stable/latest-mac.yml`
- **Beta channel**: URL points to `https://CLOUDFRONT-DOMAIN/beta/latest-mac.yml`

Channel switching changes the URL path that electron-updater queries.

### CloudFront Benefits

- **Global CDN**: Fast downloads from edge locations worldwide
- **Caching**: Artifacts cached with long TTL, manifests with short TTL (1-5 min)
- **Security**: Private S3 bucket, only accessible via CloudFront
- **Cost-effective**: Lower bandwidth costs compared to direct S3 access
- **Reliability**: 99.9% uptime SLA

## Files Modified

- `src/main.ts`: Auto-updater logic with CloudFront URL configuration
- `.github/workflows/build.yml`: Added S3 upload and CloudFront invalidation steps
- `docs/AUTO_UPDATER.md`: This documentation file
- `docs/FEED_SERVER.md`: Updated with S3 + CloudFront architecture
- `tmp/aws-setup-guide.md`: Complete AWS setup instructions

## Configuration

### Update Settings (electron-store)

Stored in `~/Library/Application Support/academia-electron/config.json`:
```json
{
  "updateChannel": "stable"
}
```

### Required GitHub Secrets

Configure these in repository Settings → Secrets and variables → Actions:

**AWS Credentials:**
- `AWS_ACCESS_KEY_ID`: IAM user access key for S3 uploads
- `AWS_SECRET_ACCESS_KEY`: IAM user secret key
- `S3_BUCKET_NAME`: S3 bucket name (e.g., `qa-academia-electron-artifacts`)
- `CLOUDFRONT_DISTRIBUTION_ID`: CloudFront distribution ID (e.g., `E1234567890ABC`)

**Apple Code Signing:**
- `CSC_LINK`: Base64-encoded .p12 certificate
- `CSC_KEY_PASSWORD`: Certificate password
- `APPLE_ID`: Apple ID for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password
- `APPLE_TEAM_ID`: Apple Developer Team ID
- `APPLE_IDENTITY`: Code signing identity

### Code Configuration

**In `src/main.ts`**, update the CloudFront domain:
```typescript
// Replace this placeholder after AWS setup:
const cloudfrontDomain = 'REPLACE-WITH-CLOUDFRONT-DOMAIN.cloudfront.net';
```

**In `.github/workflows/build.yml`**, update the CloudFront domain:
```bash
# Line ~174: Replace this placeholder after AWS setup:
CLOUDFRONT_DOMAIN="REPLACE-WITH-CLOUDFRONT-DOMAIN.cloudfront.net"
```

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
3. **Check CloudFront domain**: Verify placeholder was replaced with actual domain in `src/main.ts`
4. **Check S3 bucket**: Verify files exist in S3 at correct paths:
   ```bash
   aws s3 ls s3://qa-academia-electron-artifacts/stable/
   aws s3 ls s3://qa-academia-electron-artifacts/stable/latest-mac.yml
   ```
5. **Check CloudFront**: Test manifest URL in browser:
   ```
   https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/latest-mac.yml
   ```
6. **Check channel**: Verify correct channel is selected in tray menu
7. **Check version**: Ensure current version is older than available version

### CloudFront/S3 Specific Issues

**Issue: 403 Forbidden from CloudFront**
- **Cause**: S3 bucket policy doesn't allow CloudFront OAC access
- **Fix**: Verify bucket policy includes CloudFront distribution ARN (see `tmp/aws-setup-guide.md`)

**Issue: 404 Not Found**
- **Cause**: File doesn't exist in S3 or wrong path
- **Fix**: Check S3 bucket structure matches expected format

**Issue: Manifest not updating**
- **Cause**: CloudFront cache not invalidated
- **Fix**: Verify GitHub Actions invalidation step ran successfully:
  ```bash
  aws cloudfront get-invalidation \
    --distribution-id E1234567890ABC \
    --id INVALIDATION_ID
  ```

**Issue: CORS errors**
- **Cause**: CloudFront response headers policy missing CORS headers
- **Fix**: Verify CORS policy is attached to cache behavior (see `tmp/aws-setup-guide.md`)

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
