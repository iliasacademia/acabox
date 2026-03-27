#!/bin/bash
set -e

# ── Firewall: allow only Anthropic API, block all other outbound ──

ALLOWED_DOMAINS="api.anthropic.com"

# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow already-established connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS (UDP+TCP port 53) so we can resolve allowed domains
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Resolve each allowed domain and permit HTTPS traffic to its IPs
for domain in $ALLOWED_DOMAINS; do
  for ip in $(dig +short A "$domain" 2>/dev/null); do
    # Skip non-IP lines (e.g. CNAME records)
    if echo "$ip" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
      echo "[firewall] Allowed: $domain -> $ip:443"
    fi
  done
  for ip in $(dig +short AAAA "$domain" 2>/dev/null); do
    if echo "$ip" | grep -qE ':'; then
      ip6tables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT
      echo "[firewall] Allowed: $domain -> [$ip]:443"
    fi
  done
done

# Block everything else outbound
iptables -A OUTPUT -j REJECT --reject-with icmp-net-unreachable
ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited

echo "[firewall] Network restricted to: DNS + $ALLOWED_DOMAINS"

# ── Set up workspace (as root) ──
mkdir -p /workspace/output
chown -R user:user /workspace

# Copy CLAUDE.md to workspace (always update to latest version from image)
cp /opt/CLAUDE.md /workspace/CLAUDE.md
chown user:user /workspace/CLAUDE.md

# ── Persist environment variables for the non-root user ──
# Write directly to .profile so login shells (su - user) pick them up
for var in ANTHROPIC_API_KEY; do
  if [ -n "${!var}" ]; then
    # Remove any old entry, then append
    sed -i "/^export ${var}=/d" /home/user/.profile 2>/dev/null || true
    echo "export ${var}=\"${!var}\"" >> /home/user/.profile
  fi
done
chown user:user /home/user/.profile

# ── Start preview server in background (as user) ──
su -c "node /opt/preview-server/server.js &" user

# ── Start ttyd as non-root user (foreground) ──
# ttyd runs as root but spawns bash as 'user' via su
exec ttyd --writable su - user
