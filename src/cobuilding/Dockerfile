ARG BASE_IMAGE=ghcr.io/academia-edu/cobuilding-base:latest
FROM ${BASE_IMAGE}

# Python packages for database skills
RUN pip3 install --no-cache-dir --break-system-packages \
    requests \
    pandas \
    matplotlib \
    chembl_webresource_client \
    pubchempy \
    GEOparse \
    rcsb-api \
    biopython

WORKDIR /data
