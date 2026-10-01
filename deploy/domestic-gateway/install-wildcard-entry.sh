#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CERT_DIR=${CERT_DIR:-/etc/letsencrypt/live/prsznh.cn-wildcard}
TARGET=${TARGET:-/etc/nginx/conf.d/pms-wildcard-apps.conf}

for required in "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"; do
  if [[ ! -s "$required" ]]; then
    echo "missing wildcard certificate file: $required" >&2
    echo "issue *.prsznh.cn and prsznh.cn with DNS-01 before installing the shared entry" >&2
    exit 1
  fi
done

install -m 0644 "$SCRIPT_DIR/nginx-wildcard-apps.conf.example" "$TARGET"
nginx -t
systemctl reload nginx

status=$(curl -sS -o /dev/null -w '%{http_code}' --resolve "gateway-check.prsznh.cn:443:127.0.0.1" "https://gateway-check.prsznh.cn/_pms_gateway/healthz")
if [[ "$status" != "200" ]]; then
  echo "wildcard gateway health check failed with HTTP $status" >&2
  exit 1
fi

echo "wildcard HTTPS entry is active; future first-level app subdomains need no Nginx change"
