#!/bin/bash

# Script to build and sign the Acabox app locally
# This script requires environment variables to be set for code signing and notarization

set -e

echo "🔨 Acabox - Signed Build Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Load environment variables from .env.local if it exists
if [ -f .env.local ]; then
  echo "📝 Loading environment variables from .env.local"
  set -a
  source .env.local
  set +a
else
  echo "${YELLOW}⚠️  No .env.local file found. Using existing environment variables.${NC}"
  echo "   You can create .env.local based on .env.local.example"
  echo ""
fi

# Check required environment variables
MISSING_VARS=()

if [ -z "$APPLE_IDENTITY" ]; then
  MISSING_VARS+=("APPLE_IDENTITY")
fi

if [ -z "$APPLE_ID" ]; then
  MISSING_VARS+=("APPLE_ID")
fi

if [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
  MISSING_VARS+=("APPLE_APP_SPECIFIC_PASSWORD")
fi

if [ -z "$APPLE_TEAM_ID" ]; then
  MISSING_VARS+=("APPLE_TEAM_ID")
fi

# If any variables are missing, show error and exit
if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  echo "${RED}❌ Missing required environment variables:${NC}"
  for var in "${MISSING_VARS[@]}"; do
    echo "   - $var"
  done
  echo ""
  echo "Please set these variables in .env.local or export them in your shell."
  echo "See .env.local.example for details."
  exit 1
fi

echo "${GREEN}✅ All required environment variables are set${NC}"
echo ""
echo "Configuration:"
echo "  - APPLE_IDENTITY: $APPLE_IDENTITY"
echo "  - APPLE_ID: $APPLE_ID"
echo "  - APPLE_TEAM_ID: $APPLE_TEAM_ID"
echo ""

# Check if certificate is in keychain
echo "🔍 Checking for signing certificate in keychain..."
if security find-identity -v -p codesigning | grep -q "$APPLE_IDENTITY"; then
  echo "${GREEN}✅ Certificate found in keychain${NC}"
else
  echo "${YELLOW}⚠️  Certificate not found in keychain${NC}"
  echo "   Please import your Developer ID Application certificate (.p12) to Keychain Access"
  echo "   You can do this by double-clicking the .p12 file or using:"
  echo "   security import certificate.p12 -k ~/Library/Keychains/login.keychain-db"
  echo ""
  read -p "Do you want to continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo ""
echo "🚀 Starting build process..."
echo "   Note: First-time notarization can take 8-12 hours!"
echo "   Subsequent builds typically take ~10 minutes for notarization."
echo ""

# Run the build
npm run make

echo ""
echo "${GREEN}✅ Build complete!${NC}"
echo ""
echo "Your signed and notarized app should be in the 'out/make' directory."
echo ""
