# This Dockerfile should stay exactly this simple — two lines.
#
# Dockerfile.base (built on GitHub Actions and pushed to GHCR) contains ALL
# software: system packages, R/Bioconductor, Python venv, and every pip package.
# This file just takes that prebuilt image and sets the workspace mount point.
#
# DO NOT add RUN, pip install, or any other build steps here.
# Any new Python packages belong in Dockerfile.base.

ARG BASE_IMAGE=ghcr.io/academia-edu/cobuilding-base:latest
FROM ${BASE_IMAGE}

WORKDIR /data
