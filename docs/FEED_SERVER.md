# Auto-Updater Feed Server Implementation

This document explains how the update feed server works using AWS S3 + CloudFront as the backend.

## Overview

This implementation uses **AWS S3 + CloudFront** to distribute application updates. S3 provides secure, private storage for artifacts, while CloudFront serves as a global CDN for fast, reliable distribution. `electron-updater` uses the generic provider to fetch updates from CloudFront.

## Why S3 + CloudFront?

### Benefits

✅ **Private repository compatible**: S3 bucket stays private, no authentication needed in app
✅ **Global CDN**: CloudFront edge locations ensure fast downloads worldwide
✅ **Cost-effective**: ~$8-10/month for typical usage vs $95-290/month for custom EC2 servers
✅ **Highly available**: 99.9% uptime SLA from AWS
✅ **Fine-grained caching**: Different cache rules for manifests (short TTL) vs artifacts (long TTL)
✅ **Version history**: Keep multiple versions in S3 for rollback capability
✅ **Security**: Private S3 bucket with CloudFront Origin Access Control (OAC)
✅ **No server management**: Fully managed AWS services

### Trade-offs vs GitHub Releases

**S3 + CloudFront Advantages:**
- ✅ Works with private repositories (no authentication tokens needed)
- ✅ More control over caching and distribution
- ✅ Version history preserved in structured folders
- ✅ Can serve very large files without limits
- ✅ Better for enterprise/internal tools

**GitHub Releases Advantages:**
- ✅ Zero cost (for public repos)
- ✅ Simpler setup (no AWS configuration)
- ✅ Built-in release UI

For a **private repository** like academia-electron, S3 + CloudFront is the better choice.

## Architecture

```
┌─────────────────┐
│  GitHub Actions │
│   (CI/CD)       │
└────────┬────────┘
         │
         │ Build, Sign, Package
         │ Generate Version
         │
         ├──────────────────────────────┐
         │                              │
         ▼                              ▼
┌─────────────────────────┐   ┌─────────────────┐
│   AWS S3 (Private)      │   │ GitHub Releases │
│                         │   │   (Backup)      │
│  qa-academia-electron-  │   │                 │
│  artifacts/             │   │  Manual         │
│  ├─ stable/             │   │  downloads      │
│  │  ├─ latest-mac.yml   │   └─────────────────┘
│  │  ├─ 0.0.TIME/        │
│  │  │  ├─ .zip          │
│  │  │  ├─ .dmg          │
│  │  │  └─ .blockmap     │
│  │  └─ 0.0.TIME-1/      │
│  │                      │
│  └─ beta/               │
│     ├─ latest-mac.yml   │
│     └─ 0.0.TIME-beta/   │
└────────┬────────────────┘
         │
         │ Origin Access Control (OAC)
         │
         ▼
┌──────────────────────────┐
│   AWS CloudFront         │
│   (Global CDN)           │
│                          │
│  /.../latest-mac.yml     │◄───┐
│    Cache: 1-5 min        │    │
│                          │    │ 1. Check manifest
│  /.../VERSION/*.zip      │    │ 2. Download update
│    Cache: 1 year         │    │
└──────────────────────────┘    │
                                │
                       ┌────────┴────────┐
                       │  Academia App   │
                       │ (electron-      │
                       │  updater)       │
                       └─────────────────┘
```

## How It Works

### 1. Release Creation (GitHub Actions)

When code is pushed to main or feature branches:

```yaml
# .github/workflows/build.yml

- name: Generate version
  run: |
    # Generate timestamp-based semantic version
    TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
    VERSION="0.0.${TIMESTAMP}"

    # Determine channel from branch
    if [[ "${{ github.ref }}" == "refs/heads/main" ]]; then
      CHANNEL="stable"
    else
      CHANNEL="beta"
      VERSION="${VERSION}-beta"
    fi

    npm version $VERSION --no-git-tag-version

- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
    aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    aws-region: us-east-1

- name: Upload to S3
  run: |
    # Upload artifacts to versioned folder
    aws s3 cp out/make/zip/darwin/x64/ \
      s3://${{ secrets.S3_BUCKET_NAME }}/${CHANNEL}/${VERSION}/ \
      --recursive --include "*.zip" --include "*.blockmap"

    # Upload manifest to channel root
    aws s3 cp out/make/zip/darwin/x64/latest-mac.yml \
      s3://${{ secrets.S3_BUCKET_NAME }}/${CHANNEL}/latest-mac.yml

- name: Invalidate CloudFront cache
  run: |
    aws cloudfront create-invalidation \
      --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} \
      --paths "/${CHANNEL}/latest-mac.yml"
```

This creates artifacts in S3:
- **Path**: `s3://BUCKET/CHANNEL/VERSION/`
- **Assets**: `.zip` (for updates), `.dmg` (for manual installs), `.blockmap` (for delta updates)
- **Manifest**: `latest-mac.yml` at channel root

### 2. Manifest Generation and Modification

Electron Forge automatically generates `latest-mac.yml` during packaging. GitHub Actions then modifies it to use CloudFront URLs with versioned paths:

**Original manifest** (generated by Electron Forge):
```yaml
version: 0.0.20250106143022
releaseDate: '2025-01-06T14:30:22.000Z'
files:
  - url: Academia-darwin-x64-0.0.20250106143022.zip
    sha512: 7a3f8b2c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a...
    size: 125829120
path: Academia-darwin-x64-0.0.20250106143022.zip
sha512: 7a3f8b2c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a...
```

**Modified manifest** (uploaded to S3):
```yaml
version: 0.0.20250106143022
releaseDate: '2025-01-06T14:30:22.000Z'
files:
  - url: https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip
    sha512: 7a3f8b2c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a...
    size: 125829120
path: https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip
sha512: 7a3f8b2c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a...
```

The workflow modifies URLs to include the full CloudFront path with version folder.

### 3. Update Check (Client)

In `src/main.ts`, the app configures electron-updater:

```typescript
const cloudfrontDomain = 'YOUR-CLOUDFRONT-DOMAIN.cloudfront.net';
autoUpdater.setFeedURL({
  provider: 'generic',
  url: `https://${cloudfrontDomain}/${channel}`,
});
```

When `autoUpdater.checkForUpdates()` is called:

1. **Fetch manifest from CloudFront**:
   ```
   GET https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/latest-mac.yml
   ```
   CloudFront serves from edge location (cached for 1-5 minutes)

2. **Parse version from manifest**:
   ```typescript
   const manifestVersion = "0.0.20250106143022"
   const currentVersion = "0.0.20250105120000"
   ```

3. **Compare versions** (semantic version comparison):
   ```typescript
   if (semver.gt(manifestVersion, currentVersion)) {
     // Update available!
   }
   ```

4. **Download update** (if user approves):
   ```
   GET https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip
   ```
   CloudFront serves from edge location (cached for 1 year)
   Actual file fetched from S3 via Origin Access Control if not cached

5. **Verify checksum**:
   ```typescript
   calculatedHash = sha512(downloadedFile)
   expectedHash = manifest.sha512

   if (calculatedHash === expectedHash) {
     // Safe to install
   }
   ```

6. **Install**: On app restart, replace old app bundle with new one

## Channel Implementation

### How Channels Work

S3 + CloudFront uses **folder-based separation** to distinguish channels:

| Channel | S3 Path | Version Suffix | CloudFront URL |
|---------|---------|----------------|----------------|
| Stable  | `s3://BUCKET/stable/` | None | `https://DOMAIN/stable/` |
| Beta    | `s3://BUCKET/beta/` | `-beta` | `https://DOMAIN/beta/` |

### Request Flow

**Stable Channel:**
```bash
# electron-updater fetches manifest from CloudFront
GET https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/latest-mac.yml

# CloudFront checks edge cache (TTL: 1-5 min)
# If not cached, fetches from S3:
GET s3://qa-academia-electron-artifacts/stable/latest-mac.yml

# Manifest contains versioned download URL:
# https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip

# electron-updater downloads update from CloudFront
GET https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/0.0.20250106143022/Academia-darwin-x64-0.0.20250106143022.zip

# CloudFront checks edge cache (TTL: 1 year)
# If not cached, fetches from S3 via OAC
```

**Beta Channel:**
```bash
# electron-updater fetches manifest from CloudFront
GET https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/beta/latest-mac.yml

# Same caching and download flow as stable
# Version includes -beta suffix: 0.0.20250106143022-beta
```

### Switching Channels

When user switches channels (via tray menu):

1. Update stored preference:
   ```typescript
   store.set('updateChannel', 'beta');
   ```

2. Update electron-updater URL:
   ```typescript
   const channel = 'beta';  // or 'stable'
   autoUpdater.setFeedURL({
     provider: 'generic',
     url: `https://${cloudfrontDomain}/${channel}`,
   });
   ```

3. Next update check queries the new CloudFront path

4. App fetches `latest-mac.yml` from the new channel

## Configuration

### GitHub Actions Secrets

Required secrets in repository Settings → Secrets and variables → Actions:

**AWS Credentials:**
- `AWS_ACCESS_KEY_ID`: IAM user access key for S3 uploads
- `AWS_SECRET_ACCESS_KEY`: IAM user secret key
- `S3_BUCKET_NAME`: S3 bucket name (e.g., `qa-academia-electron-artifacts`)
- `CLOUDFRONT_DISTRIBUTION_ID`: CloudFront distribution ID

**Apple Code Signing:**
- `CSC_LINK`: Base64-encoded .p12 certificate
- `CSC_KEY_PASSWORD`: Certificate password
- `APPLE_ID`: Your Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password ([create here](https://appleid.apple.com/account/manage))
- `APPLE_TEAM_ID`: Your Apple Developer Team ID
- `APPLE_IDENTITY`: Code signing identity

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

**S3 + CloudFront as a feed server provides:**

✅ **Private repository support**: No authentication tokens needed in app
✅ **Global CDN**: Fast downloads from CloudFront edge locations
✅ **Cost-effective**: ~$8-10/month vs $95-290/month for custom servers
✅ **Highly available**: 99.9% AWS uptime SLA
✅ **Version history**: Keep multiple versions for rollback
✅ **Fine-grained caching**: Short TTL for manifests, long TTL for artifacts
✅ **Security**: Private S3 bucket with Origin Access Control
✅ **No server maintenance**: Fully managed AWS services

**Setup Requirements:**
1. AWS account with S3 and CloudFront configured (see `tmp/aws-setup-guide.md`)
2. GitHub Secrets configured for AWS credentials
3. CloudFront domain replaced in code (two placeholders)
4. Initial S3 bucket structure created

**Total Implementation Time:** ~2-3 hours (including AWS setup)
