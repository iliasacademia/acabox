#!/usr/bin/env bash
# download_model.sh — Idempotent download of the GelGenie segmentation model.
#
# Required by scripts/analyze.py. ~57MB. Run automatically by the install
# wrapper at app scaffold time (recorded by presence of this file under
# setup/, so it re-runs on container rebuilds and travels with the app).
# Safe to re-run: skips download if the file is already present and non-empty.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
MODEL_DIR="$APP_DIR/models"
MODEL_FILE="$MODEL_DIR/unet_dec_21_finetune_epoch_590.pt"
MODEL_URL="https://huggingface.co/mattaq/GelGenie-Universal-FineTune-May-2024/resolve/main/torchscript_checkpoints/unet_dec_21_finetune_epoch_590.pt"

if [ -s "$MODEL_FILE" ]; then
  echo "GelGenie model already present at $MODEL_FILE — skipping download."
  exit 0
fi

mkdir -p "$MODEL_DIR"
echo "Downloading GelGenie model -> $MODEL_FILE"
curl -L --fail --progress-bar -o "$MODEL_FILE" "$MODEL_URL"
echo "Done."
