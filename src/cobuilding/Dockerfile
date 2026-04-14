ARG BASE_IMAGE=ghcr.io/academia-edu/cobuilding-base:latest
FROM ${BASE_IMAGE}

# Create a virtual environment so pip installs are isolated from system Python
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Reinstall base-image Python packages (venv is recreated above)
RUN pip install --no-cache-dir \
    defusedxml \
    lxml \
    pypdf \
    pdfplumber \
    pdf2image \
    Pillow \
    openpyxl \
    "markitdown[pptx]" \
    jupyter_kernel_gateway \
    jupyter-client \
    ipykernel

# Python packages for database skills
RUN pip install --no-cache-dir \
    requests \
    pandas \
    matplotlib \
    chembl_webresource_client \
    pubchempy \
    GEOparse \
    rcsb-api \
    biopython

WORKDIR /data
