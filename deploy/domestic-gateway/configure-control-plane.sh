#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

API_ENV=${API_ENV:-/opt/pms-repair/apps/api/.env}
if [[ ! -f "$API_ENV" ]]; then
  echo "missing API env: $API_ENV" >&2
  exit 1
fi

install -d -m 0750 /etc/pms-gateway

ensure_secret() {
  local path=$1
  if [[ ! -s "$path" ]]; then
    openssl rand -hex 32 > "$path"
  fi
  chmod 0600 "$path"
}

upsert_env() {
  local key=$1 value=$2
  awk -v key="$key" -v value="$value" '
    BEGIN { done=0 }
    index($0, key "=") == 1 { print key "=" value; done=1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$API_ENV" > "${API_ENV}.tmp"
  chown --reference="$API_ENV" "${API_ENV}.tmp"
  chmod --reference="$API_ENV" "${API_ENV}.tmp"
  mv "${API_ENV}.tmp" "$API_ENV"
}

ensure_secret /etc/pms-gateway/frp-token
ensure_secret /etc/pms-gateway/session-secret
ensure_secret /etc/pms-gateway/frp-plugin-secret

backup="${API_ENV}.bak-gateway-control-$(date +%Y%m%d%H%M%S)"
cp -a "$API_ENV" "$backup"

upsert_env LAN_GATEWAY_FRP_TOKEN "$(tr -d '\r\n' < /etc/pms-gateway/frp-token)"
upsert_env LAN_GATEWAY_SESSION_SECRET "$(tr -d '\r\n' < /etc/pms-gateway/session-secret)"
upsert_env LAN_GATEWAY_FRP_PLUGIN_SECRET "$(tr -d '\r\n' < /etc/pms-gateway/frp-plugin-secret)"
upsert_env LAN_GATEWAY_SERVER_ADDRESS "gateway.prsznh.cn"
upsert_env LAN_GATEWAY_SERVER_PORT "443"

echo "gateway control-plane credentials configured"
echo "backup: $backup"
