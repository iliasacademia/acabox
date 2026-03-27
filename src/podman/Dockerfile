FROM ubuntu:24.04

# Detect architecture and download the matching ttyd binary
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash \
      curl \
      ca-certificates \
      git \
      python3 \
      python3-pip \
      vim \
      wget \
      jq \
      make \
      gcc \
      g++ \
      unzip \
      iptables \
      dnsutils \
      && ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then \
         TTYD_ARCH="aarch64"; \
       else \
         TTYD_ARCH="x86_64"; \
       fi \
    && curl -L -o /usr/local/bin/ttyd \
         "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${TTYD_ARCH}" \
    && chmod +x /usr/local/bin/ttyd \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Python data analysis libraries
RUN pip3 install --break-system-packages \
      pandas \
      numpy \
      matplotlib \
      seaborn \
      scipy \
      scikit-learn \
      plotly \
      openpyxl \
      xlsxwriter \
      statsmodels

# Preview server: Express static file server + chart/visualization libraries
RUN mkdir -p /opt/preview-server && \
    cd /opt/preview-server && \
    npm init -y && \
    npm install express chart.js plotly.js-dist-min d3 papaparse

COPY preview-server.js /opt/preview-server/server.js

# CLAUDE.md template — copied to workspace on first run
COPY CLAUDE.md /opt/CLAUDE.md

# Create non-root user for running Claude Code
# Use UID 1001 to avoid conflicts with existing UID 1000 in Ubuntu 24.04
RUN useradd -m -s /bin/bash -u 1001 user && \
    mkdir -p /workspace/output && \
    chown -R user:user /workspace

# Firewall entrypoint: allow only DNS + Anthropic API, block all other outbound
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace

EXPOSE 7681 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
