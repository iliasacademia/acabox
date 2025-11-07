# Auto-Updater Feed Server Implementation

This document explains how the update feed server works using GitHub Releases as the backend.

## Overview

Instead of implementing a custom update feed server, this implementation leverages **GitHub Releases** as a zero-maintenance, free, and highly available update distribution system. `electron-updater` has built-in support for GitHub Releases.

## Why GitHub Releases?

### Benefits

✅ **Zero server maintenance**: No need to host, configure, or maintain a custom server
✅ **Free hosting**: Unlimited bandwidth for public repositories
✅ **Global CDN**: GitHub's CDN ensures fast downloads worldwide
✅ **Built-in versioning**: Releases are inherently versioned with tags
✅ **Automatic manifest generation**: `electron-updater` generates update manifests
✅ **HTTPS by default**: Secure downloads without SSL certificate management
✅ **Release management UI**: GitHub's web interface for managing releases
✅ **API integration**: GitHub API for programmatic access

### Trade-offs

❌ **Less control**: Cannot implement custom rollout strategies easily
❌ **Public releases**: For private repos, requires authentication setup
❌ **No A/B testing**: Cannot easily split traffic for gradual rollouts

For most applications, especially internal tools and open-source projects, the benefits far outweigh the trade-offs.

## Architecture

```
┌─────────────────┐
│  GitHub Actions │
│   (CI/CD)       │
└────────┬────────┘
         │
         │ Build & Sign App
         │ Generate Version
         │
         ▼
┌─────────────────────────┐
│   GitHub Releases       │
│  (Update Feed Server)   │
│                         │
│  ├─ v20250106143022     │◄───────┐
│  │   ├─ .zip (update)   │        │
│  │   ├─ .dmg (manual)   │        │
│  │   └─ latest-mac.yml  │        │ Check for updates
│  │                       │        │
│  └─ v20250105120000-beta│        │
│      ├─ .zip             │        │
│      ├─ .dmg             │        │
│      └─ latest-mac.yml   │        │
└─────────────────────────┘        │
                                   │
                          ┌────────┴────────┐
                          │  Academia App   │
                          │ (electron-      │
                          │  updater)       │
                          └─────────────────┘
```

## How It Works

### 1. Release Creation (GitHub Actions)

When a git tag is pushed (e.g., `v-stable-20250106` or `v-beta-20250106`):

```yaml
# .github/workflows/build.yml

- name: Generate version
  run: |
    TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
    if [[ "$TAG" == *-beta* ]]; then
      VERSION="${TIMESTAMP}-beta"
    else
      VERSION="$TIMESTAMP"
    fi
    npm version $VERSION --no-git-tag-version

- name: Create Release
  uses: softprops/action-gh-release@v1
  with:
    files: |
      out/make/**/*.dmg
      out/make/**/*.zip
    draft: false
    prerelease: ${{ contains(github.ref, 'beta') }}
```

This creates a GitHub Release with:
- **Tag**: `v20250106143022` or `v20250106143022-beta`
- **Assets**: `.zip` (for updates), `.dmg` (for manual installs)
- **Manifest**: `latest-mac.yml` (auto-generated)

### 2. Manifest Generation

`electron-updater` automatically generates `latest-mac.yml` when you upload a `.zip` file:

```yaml
version: 20250106143022
releaseDate: '2025-01-06T14:30:22.000Z'
files:
  - url: Academia-darwin-x64-20250106143022.zip
    sha512: 7a3f8b2c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b
    size: 125829120
path: Academia-darwin-x64-20250106143022.zip
sha512: 7a3f8b2c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b
releaseNotes: |
  **Version:** 20250106143022
  **Channel:** stable
  **Build Date:** 20250106143022

  Automated release from GitHub Actions.
```

### 3. Update Check (Client)

In `src/main.ts`, the app configures electron-updater:

```typescript
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'academia-edu',
  repo: 'academia-electron',
});
autoUpdater.channel = 'stable'; // or 'beta'
```

When `autoUpdater.checkForUpdates()` is called:

1. **Fetch manifest**:
   ```
   GET https://api.github.com/repos/academia-edu/academia-electron/releases
   ```

2. **Filter by channel**:
   - Stable: Latest release where `prerelease === false`
   - Beta: Latest release where `prerelease === true` and tag contains `-beta`

3. **Download manifest**:
   ```
   GET https://github.com/academia-edu/academia-electron/releases/download/v20250106143022/latest-mac.yml
   ```

4. **Compare versions**:
   ```typescript
   currentVersion = "20250105120000"
   availableVersion = "20250106143022"

   // String comparison works because timestamps are lexicographically ordered
   if (availableVersion > currentVersion) {
     // Update available!
   }
   ```

5. **Download update** (if user approves):
   ```
   GET https://github.com/academia-edu/academia-electron/releases/download/v20250106143022/Academia-darwin-x64-20250106143022.zip
   ```

6. **Verify checksum**:
   ```typescript
   calculatedHash = sha512(downloadedFile)
   expectedHash = manifest.sha512

   if (calculatedHash === expectedHash) {
     // Safe to install
   }
   ```

7. **Install**: On app restart, replace old app bundle with new one

## Channel Implementation

### How Channels Work

GitHub Releases uses the **prerelease flag** to distinguish channels:

| Channel | Prerelease Flag | Tag Pattern | Release Type |
|---------|----------------|-------------|--------------|
| Stable  | `false`        | `v20250106143022` | Regular release |
| Beta    | `true`         | `v20250106143022-beta` | Prerelease |

### API Request Flow

**Stable Channel:**
```bash
# electron-updater fetches releases
GET https://api.github.com/repos/academia-edu/academia-electron/releases

# Filter: prerelease === false
# Sort by date, take latest
# Result: v20250106143022

# Download manifest
GET https://github.com/academia-edu/academia-electron/releases/download/v20250106143022/latest-mac.yml
```

**Beta Channel:**
```bash
# electron-updater fetches releases
GET https://api.github.com/repos/academia-edu/academia-electron/releases

# Filter: prerelease === true AND tag contains '-beta'
# Sort by date, take latest
# Result: v20250106143022-beta

# Download manifest
GET https://github.com/academia-edu/academia-electron/releases/download/v20250106143022-beta/latest-mac.yml
```

### Switching Channels

When user switches channels (via tray menu):

1. Update stored preference:
   ```typescript
   store.set('updateChannel', 'beta');
   ```

2. Update electron-updater:
   ```typescript
   autoUpdater.channel = 'beta';
   ```

3. Next update check uses new channel

4. App finds latest release in that channel

## Configuration

### GitHub Actions Secrets

Required secrets in repository settings:

- `APPLE_ID`: Your Apple ID email
- `APPLE_ID_PASSWORD`: App-specific password ([create here](https://appleid.apple.com/account/manage))
- `APPLE_TEAM_ID`: Your Apple Developer Team ID

### forge.config.js

```javascript
module.exports = {
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'academia-edu',
          name: 'academia-electron',
        },
        draft: false,        // Publish immediately
        prerelease: false,   // Set dynamically in workflow
      },
    },
  ],
};
```

## Deployment Workflow

### Creating a Stable Release

```bash
# 1. Ensure you're on main branch
git checkout main
git pull

# 2. Create and push stable tag
git tag v-stable-$(date -u +%Y%m%d%H%M%S)
git push origin --tags

# 3. GitHub Actions automatically:
#    - Generates timestamp version
#    - Builds and signs app
#    - Creates GitHub Release (prerelease: false)
#    - Uploads .zip, .dmg, and latest-mac.yml

# 4. Users on stable channel receive update
```

### Creating a Beta Release

```bash
# 1. Create and push beta tag
git tag v-beta-$(date -u +%Y%m%d%H%M%S)
git push origin --tags

# 2. GitHub Actions automatically:
#    - Generates timestamp-beta version
#    - Builds and signs app
#    - Creates GitHub Release (prerelease: true)
#    - Uploads assets

# 3. Users on beta channel receive update
```

## Comparison with Custom Server

### Custom Server Approach

**Pros:**
- Full control over rollout strategy
- A/B testing capabilities
- Analytics and telemetry
- Gradual rollouts
- Private/authenticated distribution

**Cons:**
- Server hosting costs
- Infrastructure maintenance
- SSL certificate management
- CDN setup for global distribution
- Uptime monitoring
- Security patching
- Backup and disaster recovery

**Example Custom Server:**
```typescript
// server.js
app.get('/updates/latest-mac.yml', (req, res) => {
  const channel = req.query.channel || 'stable';
  const manifest = generateManifest(channel);
  res.yaml(manifest);
});

app.get('/updates/:version/:filename', (req, res) => {
  const file = getUpdateFile(req.params.version, req.params.filename);
  res.download(file);
});
```

### GitHub Releases Approach (Current)

**Pros:**
- Zero server costs
- Zero maintenance
- Automatic CDN
- Built-in security
- Simple deployment

**Cons:**
- Limited rollout control
- No built-in analytics
- Public by default (can use private repos)

## Cost Analysis

### Custom Server (AWS Example)

Monthly costs for ~1000 active users with 100MB updates:

- **EC2 Instance**: $10-50/month (t3.small - t3.medium)
- **S3 Storage**: $5-10/month (100GB updates stored)
- **CloudFront CDN**: $50-200/month (10TB transfer)
- **Load Balancer**: $20/month
- **SSL Certificate**: Free (AWS Certificate Manager)
- **Monitoring**: $10/month
- **Total**: **$95-290/month**

### GitHub Releases (Current)

Monthly costs:
- **Public repo**: **$0/month** ✨
- **Private repo**: $0/month (included in GitHub plan)
- **Bandwidth**: Unlimited
- **Storage**: Unlimited for releases
- **Total**: **$0/month** 🎉

## Security

### GitHub Releases Security

✅ **HTTPS enforced**: All downloads over secure connection
✅ **Integrity checks**: SHA512 checksums verified
✅ **Code signing**: Apps signed with Apple Developer certificate
✅ **Notarization**: macOS apps notarized by Apple
✅ **Tamper protection**: Modified files fail checksum verification
✅ **CDN security**: GitHub's infrastructure security

### Authentication (Private Repos)

For private repositories, add GitHub token:

```typescript
autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'academia-edu',
  repo: 'academia-electron',
  token: process.env.GITHUB_TOKEN, // Optional for public repos
});
```

## Monitoring

### GitHub Release Metrics

View in GitHub:
- Download counts per release
- Release publish dates
- Asset sizes

### App-Side Logging

All update events logged with `[Auto-Updater]` prefix:

```typescript
autoUpdater.on('checking-for-update', () => {
  console.log('[Auto-Updater] Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[Auto-Updater] Update available:', info.version);
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Auto-Updater] Update downloaded:', info.version);
});

autoUpdater.on('error', (error) => {
  console.error('[Auto-Updater] Error:', error);
});
```

## Troubleshooting

### Issue: Updates not appearing

**Check:**
1. Is release published (not draft)?
2. Is `prerelease` flag correct for channel?
3. Does release have `.zip` asset?
4. Is `latest-mac.yml` present?
5. Is app version older than release version?

### Issue: Download fails

**Check:**
1. GitHub API rate limits (60/hour for unauthenticated)
2. Network connectivity
3. GitHub status (status.github.com)
4. File size within GitHub limits (2GB per asset)

### Issue: Wrong channel updates

**Check:**
1. Current channel: `store.get('updateChannel')`
2. Release prerelease flag matches channel
3. Tag contains correct suffix (`-beta` for beta)

## Future Enhancements

### Advanced Features (Require Custom Server)

If you outgrow GitHub Releases, consider:

1. **Staged Rollouts**: Release to 10% of users, then 50%, then 100%
2. **A/B Testing**: Test two versions simultaneously
3. **Analytics**: Track update success rates, download speeds
4. **Delta Updates**: Only download changed files (reduce bandwidth)
5. **User Segmentation**: Different updates for different user groups
6. **Rollback**: Automatically revert if errors detected

### Hybrid Approach

Keep GitHub Releases for hosting, add custom proxy for analytics:

```
App → Custom Proxy (analytics) → GitHub Releases (download)
```

This gives you analytics while keeping the simplicity of GitHub Releases.

## Summary

**GitHub Releases as a feed server provides:**

✅ Production-ready solution out of the box
✅ Zero maintenance and costs
✅ Built-in CDN and security
✅ Simple deployment workflow
✅ Excellent for teams without dedicated DevOps

**Recommendation:** Start with GitHub Releases. Migrate to custom server only if you need advanced features like staged rollouts or detailed analytics.
