# Code Signing and Notarization Guide

This document explains how to set up code signing and notarization for this Electron app on macOS.

## Overview

Code signing and notarization are required to distribute macOS apps outside the Mac App Store. This ensures users can run the app without Gatekeeper warnings.

**Important:** First-time notarization can take 8-12 hours. Subsequent builds typically take ~10 minutes.

## Prerequisites

- Apple Developer account ($99/year) enrolled in the Apple Developer Program
- Xcode installed on your Mac
- Developer ID Application certificate

## Local Development Setup

### 1. Get Your Developer ID Application Certificate

If you don't have a certificate yet:

1. Open **Xcode**
2. Go to **Xcode > Settings > Accounts**
3. Select your Apple ID and click **Manage Certificates**
4. Click **+** and select **Developer ID Application**
5. Export the certificate:
   - Right-click the certificate
   - Select **Export "Developer ID Application: ..."**
   - Save as `certificate.p12`
   - Set a strong password (you'll need this later)

### 2. Find Your Certificate Identity

To find your certificate identity name, run:

```bash
security find-identity -v -p codesigning
```

Look for a line like:
```
1) XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX "Developer ID Application: Your Company Name (XXXXXXXXXX)"
```

The identity string is: `Developer ID Application: Your Company Name (XXXXXXXXXX)`

### 3. Create App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com/account/manage)
2. Sign in with your Apple ID
3. Go to **Security** > **App-Specific Passwords**
4. Click **Generate Password**
5. Name it something descriptive (e.g., "Electron App Notarization")
6. Save the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

### 4. Configure Local Environment

1. Copy the environment template:
   ```bash
   cp .env.local.example .env.local
   ```

2. Edit `.env.local` with your values:
   ```bash
   APPLE_IDENTITY="Developer ID Application: Your Company Name (XXXXXXXXXX)"
   APPLE_ID="your-apple-id@example.com"
   APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   APPLE_TEAM_ID="XXXXXXXXXX"
   ```

### 5. Import Certificate to Keychain

If the certificate isn't already in your keychain:

```bash
security import certificate.p12 -k ~/Library/Keychains/login.keychain-db
```

Or simply double-click the `.p12` file and follow the prompts.

### 6. Build and Sign

Run the build script:

```bash
./scripts/build-signed.sh
```

The script will:
- Verify all required environment variables are set
- Check that the certificate is in your keychain
- Build, sign, and notarize the app
- Output the signed app to `out/make/`

## GitHub Actions Setup

To enable automatic signing in CI/CD, you need to add secrets to your GitHub repository.

### Required GitHub Secrets

Go to your repository **Settings > Secrets and variables > Actions** and add:

| Secret Name | Description | How to Get It |
|------------|-------------|---------------|
| `APPLE_ID` | Your Apple Developer email | Your Apple ID email address |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password | Created at appleid.apple.com (see step 3 above) |
| `APPLE_TEAM_ID` | Your Team ID | From developer.apple.com/account (Membership Details) |
| `APPLE_IDENTITY` | Certificate identity name | From `security find-identity -v -p codesigning` |
| `CSC_LINK` | Base64-encoded certificate | See below |
| `CSC_KEY_PASSWORD` | Certificate password | Password you set when exporting the .p12 |

### Creating CSC_LINK Secret

The `CSC_LINK` secret is your certificate.p12 file encoded in base64:

```bash
base64 -i certificate.p12 | pbcopy
```

This copies the base64-encoded certificate to your clipboard. Paste it as the value for `CSC_LINK`.

**Important:** Keep your `certificate.p12` file and password secure. Do not commit them to git.

### Verify GitHub Actions Setup

After adding all secrets:

1. Push a commit to the `main` branch or manually trigger the workflow
2. Go to **Actions** tab in GitHub
3. Watch the build process
4. The "Setup code signing certificate" step should succeed
5. The "Package application" step will sign and notarize the app
6. First-time notarization takes 8-12 hours - be patient!

## Troubleshooting

### "No identity found" error

- Verify the certificate is imported to your keychain
- Check that `APPLE_IDENTITY` exactly matches the output of `security find-identity`

### "App-specific password is incorrect" error

- Regenerate the app-specific password at appleid.apple.com
- Ensure you're using the app-specific password, not your Apple ID password

### Notarization takes too long

- First-time notarization can take 8-12 hours - this is normal
- Subsequent builds typically take ~10 minutes
- You can check notarization status at [developer.apple.com/support](https://developer.apple.com/support/)

### Certificate not found in CI

- Verify `CSC_LINK` is correctly base64-encoded
- Verify `CSC_KEY_PASSWORD` matches the password you set when exporting
- Check GitHub Actions logs for specific error messages

## Files Modified

- `forge.config.js` - Added notarization configuration
- `.github/workflows/build.yml` - Added certificate import and cleanup
- `scripts/build-signed.sh` - Local build script
- `.env.local.example` - Environment variable template

## References

- [Apple Code Signing Guide](https://developer.apple.com/support/code-signing/)
- [Apple Notarization Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Electron Forge Code Signing](https://www.electronforge.io/guides/code-signing)
- [omkarcloud/macos-code-signing-example](https://github.com/omkarcloud/macos-code-signing-example)
