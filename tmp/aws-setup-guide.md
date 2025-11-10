# AWS Setup Guide for Academia Electron Auto-Updater

This guide provides step-by-step instructions for setting up AWS infrastructure (S3 + CloudFront) to distribute auto-updates for the Academia Electron app.

## Architecture Overview

```
Electron App (client)
    ↓
CloudFront CDN (https://xxxxx.cloudfront.net)
    ↓
S3 Bucket (production-academia-electron-artifacts) [Private]
    ├── stable/
    │   ├── latest-mac.yml
    │   └── 0.0.TIMESTAMP/
    │       ├── *.zip
    │       ├── *.dmg
    │       └── *.blockmap
    └── beta/
        └── (same structure)

GitHub Actions
    ↓ (uploads artifacts)
S3 Bucket
```

## Benefits of CloudFront + Private S3

✅ **Security**: S3 bucket stays private, only accessible via CloudFront
✅ **Performance**: Global CDN with edge locations worldwide
✅ **Cost**: Lower bandwidth costs with CloudFront caching
✅ **Reliability**: 99.9% uptime SLA
✅ **Cache control**: Fine-grained caching rules for manifests vs artifacts

---

## Part 1: Create S3 Bucket

### Step 1.1: Create Bucket

1. Go to AWS Console → **S3** → **Create bucket**
2. Configure:
   - **Bucket name**: `production-academia-electron-artifacts`
   - **AWS Region**: `us-east-1`
   - **Block Public Access settings**: ✅ Keep all enabled (bucket will be private)
   - **Bucket Versioning**: Optional (recommended for rollback capability)
   - **Default encryption**: SSE-S3 (recommended)
3. Click **Create bucket**

### Step 1.2: Create Folder Structure

After bucket creation, create this folder structure:

```
production-academia-electron-artifacts/
├── stable/
└── beta/
```

You can create these via Console or AWS CLI:
```bash
aws s3api put-object --bucket production-academia-electron-artifacts --key stable/
aws s3api put-object --bucket production-academia-electron-artifacts --key beta/
```

### Step 1.3: Keep Bucket Private

**Important**: Do NOT add a bucket policy for public access. CloudFront will access the bucket via Origin Access Control (OAC).

---

## Part 2: Create CloudFront Distribution

### Step 2.1: Create Distribution

1. Go to AWS Console → **CloudFront** → **Create distribution**

### Step 2.2: Origin Configuration

**Origin domain**: Select `production-academia-electron-artifacts.s3.us-east-1.amazonaws.com`

**Origin access**:
- Select: ✅ **Origin access control settings (recommended)**
- Click **Create control setting**
  - **Name**: `academia-electron-s3-oac`
  - **Signing behavior**: ✅ Sign requests (recommended)
  - **Origin type**: S3
  - Click **Create**

**⚠️ Important**: After creating the distribution, AWS will show a banner with a bucket policy. You'll need to add this to your S3 bucket (covered in Step 2.6).

### Step 2.3: Default Cache Behavior

**Viewer protocol policy**:
- ✅ Redirect HTTP to HTTPS

**Allowed HTTP methods**:
- ✅ GET, HEAD, OPTIONS

**Cache policy**:
- Select: **CachingOptimized** (for .zip, .dmg files)
- We'll create a custom policy for `latest-mac.yml` later

**Origin request policy**:
- None needed

**Response headers policy**:
- Select: **CORS-with-preflight-and-SecurityHeadersPolicy**
- Or create custom (see Step 2.4)

### Step 2.4: Create Custom Response Headers Policy (Optional but Recommended)

If you want more control over CORS:

1. Go to **CloudFront** → **Policies** → **Response headers** → **Create policy**
2. Configure:
   - **Name**: `academia-electron-cors-policy`
   - **CORS headers**:
     - ✅ Access-Control-Allow-Origin: `*`
     - ✅ Access-Control-Allow-Methods: `GET, HEAD, OPTIONS`
     - ✅ Access-Control-Allow-Headers: `*`
     - ✅ Access-Control-Max-Age: `3600`
   - **Security headers** (optional):
     - ✅ Strict-Transport-Security
     - ✅ Content-Type-Options
3. Click **Create**
4. Go back to your distribution → **Behaviors** → Edit default → Set this as **Response headers policy**

### Step 2.5: Create Cache Behaviors for latest-mac.yml

We need different caching for the manifest file (short TTL) vs artifacts (long TTL).

1. Go to your distribution → **Behaviors** → **Create behavior**
2. Configure for manifest files:
   - **Path pattern**: `*/latest-mac.yml`
   - **Origin**: Select your S3 origin
   - **Viewer protocol policy**: Redirect HTTP to HTTPS
   - **Allowed HTTP methods**: GET, HEAD, OPTIONS
   - **Cache policy**: Create new cache policy:
     - Name: `academia-manifest-cache`
     - **Minimum TTL**: 0 seconds
     - **Maximum TTL**: 300 seconds (5 minutes)
     - **Default TTL**: 60 seconds (1 minute)
     - **Cache key settings**:
       - Headers: None
       - Cookies: None
       - Query strings: None
   - **Origin request policy**: None
   - **Response headers policy**: Same CORS policy as above
3. Click **Create behavior**
4. **Set priority**: Move this behavior to **priority 0** (above default)

### Step 2.6: Update S3 Bucket Policy

After creating the distribution, CloudFront shows a banner with the required bucket policy.

1. Copy the policy from CloudFront banner
2. Go to **S3** → `production-academia-electron-artifacts` → **Permissions** → **Bucket policy**
3. Paste the policy (should look like this):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::production-academia-electron-artifacts/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

4. Click **Save changes**

### Step 2.7: Wait for Deployment

CloudFront distribution deployment takes **15-20 minutes**. Status will change from "In Progress" to "Enabled".

### Step 2.8: Note Your CloudFront Domain

After deployment, note your distribution domain name:
- Format: `d1234567890abc.cloudfront.net`
- Full URL will be: `https://d1234567890abc.cloudfront.net/`

**Save this domain** - you'll need it for the Electron app configuration.

---

## Part 3: Create IAM User for GitHub Actions

### Step 3.1: Create IAM User

1. Go to AWS Console → **IAM** → **Users** → **Create user**
2. Configure:
   - **User name**: `github-actions-academia-electron`
   - **Access type**: ✅ Programmatic access
3. Click **Next**

### Step 3.2: Create Custom Policy

1. Click **Attach policies directly** → **Create policy**
2. Switch to **JSON** tab
3. Paste this policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3UploadAccess",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::production-academia-electron-artifacts",
        "arn:aws:s3:::production-academia-electron-artifacts/*"
      ]
    },
    {
      "Sid": "CloudFrontInvalidation",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation"
      ],
      "Resource": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
    }
  ]
}
```

**Important**: Replace `YOUR_ACCOUNT_ID` and `YOUR_DISTRIBUTION_ID` with your actual values.

4. Click **Next**
5. **Policy name**: `GitHubActionsAcademiaElectronPolicy`
6. Click **Create policy**

### Step 3.3: Attach Policy to User

1. Go back to user creation
2. Refresh the policy list
3. Search for `GitHubActionsAcademiaElectronPolicy`
4. ✅ Check it
5. Click **Next** → **Create user**

### Step 3.4: Create Access Keys

1. Click on the created user
2. Go to **Security credentials** tab
3. Click **Create access key**
4. Select: **Application running outside AWS**
5. Click **Next** → **Create access key**
6. **⚠️ IMPORTANT**: Copy both:
   - **Access key ID** (starts with `AKIA...`)
   - **Secret access key** (shown only once!)
7. Click **Done**

**Save these credentials securely** - you'll add them to GitHub Secrets.

---

## Part 4: Configure GitHub Repository Secrets

### Step 4.1: Add AWS Credentials

1. Go to your GitHub repository: `https://github.com/academia-edu/academia-electron`
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add these secrets:

**Secret 1: AWS_ACCESS_KEY_ID**
- Name: `AWS_ACCESS_KEY_ID`
- Secret: Paste the access key ID from Step 3.4

**Secret 2: AWS_SECRET_ACCESS_KEY**
- Name: `AWS_SECRET_ACCESS_KEY`
- Secret: Paste the secret access key from Step 3.4

**Secret 3: S3_BUCKET_NAME**
- Name: `S3_BUCKET_NAME`
- Secret: `production-academia-electron-artifacts`
- **Important**: This makes the bucket name configurable for future changes

**Secret 4: CLOUDFRONT_DISTRIBUTION_ID**
- Name: `CLOUDFRONT_DISTRIBUTION_ID`
- Secret: Paste your CloudFront distribution ID (e.g., `E1234567890ABC`)
  - Find this in CloudFront console → Distributions → ID column

**Secret 5: AWS_REGION** (optional, hardcoded in workflow as `us-east-1`)
- Name: `AWS_REGION`
- Secret: `us-east-1`

### Step 4.2: Verify Secrets

After adding, you should see these AWS-related secrets (plus any existing Apple code signing secrets):
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET_NAME`
- `CLOUDFRONT_DISTRIBUTION_ID`
- `AWS_REGION` (optional)

---

## Part 5: Testing the Setup

### Step 5.1: Test S3 Upload Access

From your local machine with AWS CLI configured:

```bash
# Test upload
echo "test" > test.txt
aws s3 cp test.txt s3://production-academia-electron-artifacts/stable/test.txt

# Test download via CloudFront
curl -I https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/test.txt

# Should return 200 OK
```

### Step 5.2: Test CloudFront Cache Invalidation

```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_DISTRIBUTION_ID \
  --paths "/stable/latest-mac.yml" "/beta/latest-mac.yml"
```

Should return:
```json
{
  "Invalidation": {
    "Id": "I...",
    "Status": "InProgress",
    ...
  }
}
```

### Step 5.3: Test CORS

```bash
curl -H "Origin: https://example.com" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: X-Requested-With" \
     -X OPTIONS \
     https://YOUR-CLOUDFRONT-DOMAIN.cloudfront.net/stable/test.txt

# Should return CORS headers:
# access-control-allow-origin: *
# access-control-allow-methods: GET, HEAD, OPTIONS
```

---

## Summary Checklist

Before proceeding with Electron app implementation, verify:

- ✅ S3 bucket `production-academia-electron-artifacts` created in `us-east-1`
- ✅ Bucket is private (Block Public Access enabled)
- ✅ Folders created: `stable/` and `beta/`
- ✅ CloudFront distribution created and deployed
- ✅ Origin Access Control (OAC) configured
- ✅ S3 bucket policy updated to allow CloudFront
- ✅ Cache behavior created for `*/latest-mac.yml` (short TTL)
- ✅ Default cache behavior for artifacts (long TTL)
- ✅ CORS response headers policy configured
- ✅ IAM user created with S3 + CloudFront permissions
- ✅ Access keys created and saved
- ✅ GitHub Secrets added:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `S3_BUCKET_NAME`
  - `CLOUDFRONT_DISTRIBUTION_ID`
  - `AWS_REGION` (optional)
- ✅ CloudFront domain noted: `https://_____.cloudfront.net`

---

## Key Values to Share

After completing this setup, provide these values for Electron app configuration:

1. **CloudFront Domain**: `https://d1234567890abc.cloudfront.net`
2. **CloudFront Distribution ID**: `E1234567890ABC`
3. **S3 Bucket Name**: `production-academia-electron-artifacts`
4. **AWS Region**: `us-east-1`

---

## Cost Estimate

For ~1000 active users with 100MB updates:

**S3 Storage**:
- 10 versions × 100MB × 2 channels = ~2GB
- Cost: $0.023/GB = **~$0.05/month**

**S3 Requests**:
- Negligible (PUT from GitHub Actions, GET from CloudFront)
- Cost: **~$0.01/month**

**CloudFront**:
- 1000 users × 100MB = 100GB/month
- First 10TB = $0.085/GB = **~$8.50/month**
- Requests: 1000 × 2 = 2000 requests = **~$0.01/month**

**Total**: **~$8.60/month**

(Much cheaper than running custom EC2 servers at $95-290/month)

---

## Troubleshooting

### Issue: CloudFront returns 403 Forbidden

**Cause**: S3 bucket policy not updated or OAC not configured correctly

**Fix**:
1. Verify bucket policy includes CloudFront OAC permission
2. Verify distribution uses OAC (not legacy OAI)
3. Check that policy ARN matches your distribution ID

### Issue: CloudFront returns 404 Not Found

**Cause**: File doesn't exist in S3 or wrong path

**Fix**:
1. Verify file exists in S3: `aws s3 ls s3://production-academia-electron-artifacts/stable/`
2. Verify CloudFront path matches S3 key exactly
3. Wait for file to propagate (can take 1-2 minutes)

### Issue: CORS errors in Electron app

**Cause**: Response headers policy not configured

**Fix**:
1. Verify CORS policy is attached to cache behavior
2. Check headers in response: `curl -I https://DOMAIN/stable/test.txt`
3. Should see `access-control-allow-origin: *`

### Issue: latest-mac.yml not updating

**Cause**: CloudFront cache not invalidated

**Fix**:
1. After uploading new `latest-mac.yml`, create invalidation:
   ```bash
   aws cloudfront create-invalidation \
     --distribution-id YOUR_ID \
     --paths "/stable/latest-mac.yml" "/beta/latest-mac.yml"
   ```
2. Wait 1-2 minutes for invalidation to complete
3. Verify: `curl https://DOMAIN/stable/latest-mac.yml`

### Issue: GitHub Actions upload fails

**Cause**: IAM permissions insufficient

**Fix**:
1. Verify IAM policy includes `s3:PutObject` and `s3:PutObjectAcl`
2. Verify GitHub Secrets are set correctly
3. Check Actions logs for specific error message
4. Verify bucket name and region match in workflow

---

## Next Steps

Once AWS setup is complete:

1. ✅ Provide CloudFront domain to developer
2. ✅ Verify GitHub Secrets are added
3. 🔄 Developer will update Electron app code
4. 🔄 Developer will update GitHub Actions workflow
5. 🔄 Test first deployment to S3 + CloudFront
6. 🔄 Test update flow in Electron app

---

## Security Best Practices

✅ **S3 bucket is private** - only accessible via CloudFront
✅ **IAM user has minimal permissions** - only S3 upload and CloudFront invalidation
✅ **HTTPS enforced** - all traffic encrypted
✅ **No public credentials** - AWS keys stored as GitHub Secrets
✅ **Access keys rotated** - rotate every 90 days (recommended)

---

## Additional Resources

- [CloudFront + S3 Official Guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [Origin Access Control (OAC) Documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [CloudFront Cache Behaviors](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesCacheBehavior)
- [IAM Best Practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
