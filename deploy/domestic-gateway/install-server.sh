#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
API_ENV=${API_ENV:-/opt/pms-repair/apps/api/.env}
FRP_VERSION=0.71.0
FRP_SHA256=84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716
OAUTH_VERSION=7.15.4
OAUTH_SHA256=4fbe902189aab713d9c0519b90a645032d4636ecb523dc36f5cc312d8ebef1e2
CALLBACK=https://caiwu.prsznh.cn/oauth2/callback
DOWNLOAD_DIR=${DOWNLOAD_DIR:-}

read_env() {
  local key=$1
  sed -n "s/^${key}=//p" "$API_ENV" | head -n 1
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

OIDC_CLIENT_ID=$(read_env EXTERNAL_OIDC_CLIENT_ID)
OIDC_CLIENT_SECRET=$(read_env EXTERNAL_OIDC_CLIENT_SECRET)
if [[ -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  echo "EXTERNAL_OIDC_CLIENT_ID/SECRET is missing" >&2
  exit 1
fi

install -d -m 0750 /etc/pms-gateway /var/log/pms-gateway
if ! id -u pms-gateway >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin pms-gateway
fi
if [[ ! -s /etc/pms-gateway/frp-token ]]; then
  openssl rand -hex 32 > /etc/pms-gateway/frp-token
fi
if [[ ! -s /etc/pms-gateway/oauth-cookie-secret ]]; then
  openssl rand 32 > /etc/pms-gateway/oauth-cookie-secret
fi
if [[ ! -s /etc/pms-gateway/session-secret ]]; then
  openssl rand -hex 32 > /etc/pms-gateway/session-secret
fi
if [[ ! -s /etc/pms-gateway/frp-plugin-secret ]]; then
  openssl rand -hex 32 > /etc/pms-gateway/frp-plugin-secret
fi
printf '%s' "$OIDC_CLIENT_SECRET" > /etc/pms-gateway/oidc-client-secret
chmod 0600 /etc/pms-gateway/frp-token /etc/pms-gateway/oauth-cookie-secret /etc/pms-gateway/oidc-client-secret /etc/pms-gateway/session-secret /etc/pms-gateway/frp-plugin-secret
upsert_env LAN_GATEWAY_FRP_TOKEN "$(tr -d '\r\n' < /etc/pms-gateway/frp-token)"
upsert_env LAN_GATEWAY_SESSION_SECRET "$(tr -d '\r\n' < /etc/pms-gateway/session-secret)"
upsert_env LAN_GATEWAY_FRP_PLUGIN_SECRET "$(tr -d '\r\n' < /etc/pms-gateway/frp-plugin-secret)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ -n "$DOWNLOAD_DIR" && -f "$DOWNLOAD_DIR/frp-linux.tar.gz" ]]; then
  cp "$DOWNLOAD_DIR/frp-linux.tar.gz" "$tmp/frp.tar.gz"
else
  curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz" -o "$tmp/frp.tar.gz"
fi
echo "${FRP_SHA256}  $tmp/frp.tar.gz" | sha256sum -c -
# The upstream archive also contains frpc. The public server only needs frps;
# avoid materializing frpc in /tmp because host-security products correctly
# classify generic tunnelling clients as risk tools even when the signed
# upstream archive is authentic.
tar -xOf "$tmp/frp.tar.gz" "frp_${FRP_VERSION}_linux_amd64/frps" > "$tmp/frps"
test -s "$tmp/frps"
install -m 0755 "$tmp/frps" /usr/local/bin/frps

if [[ -n "$DOWNLOAD_DIR" && -f "$DOWNLOAD_DIR/oauth-linux.tar.gz" ]]; then
  cp "$DOWNLOAD_DIR/oauth-linux.tar.gz" "$tmp/oauth.tar.gz"
else
  curl -fsSL "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v${OAUTH_VERSION}/oauth2-proxy-v${OAUTH_VERSION}.linux-amd64.tar.gz" -o "$tmp/oauth.tar.gz"
fi
echo "${OAUTH_SHA256}  $tmp/oauth.tar.gz" | sha256sum -c -
tar -xzf "$tmp/oauth.tar.gz" -C "$tmp"
install -m 0755 "$tmp/oauth2-proxy-v${OAUTH_VERSION}.linux-amd64/oauth2-proxy" /usr/local/bin/oauth2-proxy

sed "s/__FRP_PLUGIN_SECRET__/$(tr -d '\r\n' < /etc/pms-gateway/frp-plugin-secret)/g" "$SCRIPT_DIR/frps.toml.example" > /etc/pms-gateway/frps.toml
sed "s/__OIDC_CLIENT_ID__/${OIDC_CLIENT_ID//\//\\/}/g" "$SCRIPT_DIR/oauth2-proxy.cfg.example" \
  > /etc/pms-gateway/oauth2-proxy-caiwu.cfg
chmod 0640 /etc/pms-gateway/frps.toml /etc/pms-gateway/oauth2-proxy-caiwu.cfg

redirects=$(read_env EXTERNAL_OIDC_REDIRECT_URIS)
case ",${redirects}," in
  *",${CALLBACK},"*) ;;
  *)
    cp -a "$API_ENV" "${API_ENV}.bak-domestic-gateway-$(date +%Y%m%d%H%M%S)"
    next="${redirects:+${redirects},}${CALLBACK}"
    awk -v value="$next" '
      BEGIN { done=0 }
      /^EXTERNAL_OIDC_REDIRECT_URIS=/ { print "EXTERNAL_OIDC_REDIRECT_URIS=" value; done=1; next }
      { print }
      END { if (!done) print "EXTERNAL_OIDC_REDIRECT_URIS=" value }
    ' "$API_ENV" > "${API_ENV}.tmp"
    chown --reference="$API_ENV" "${API_ENV}.tmp"
    chmod --reference="$API_ENV" "${API_ENV}.tmp"
    mv "${API_ENV}.tmp" "$API_ENV"
    ;;
esac

install -m 0644 "$SCRIPT_DIR/frps.service" /etc/systemd/system/frps.service
install -m 0644 "$SCRIPT_DIR/oauth2-proxy-caiwu.service" /etc/systemd/system/oauth2-proxy-caiwu.service
install -d -o root -g root -m 0755 /opt/pms-gateway-router
install -m 0644 "$SCRIPT_DIR/../../tools/pms-gateway-router/server.mjs" /opt/pms-gateway-router/server.mjs
install -m 0644 "$SCRIPT_DIR/pms-gateway-router.service" /etc/systemd/system/pms-gateway-router.service
if [[ ! -f /etc/pms-gateway/router.env ]]; then
  cat > /etc/pms-gateway/router.env <<'EOF'
GATEWAY_ROUTER_HOST=127.0.0.1
GATEWAY_ROUTER_PORT=4190
PMS_API_INTERNAL_URL=http://127.0.0.1:3000/api/v1
PMS_PUBLIC_API_URL=https://prsznh.cn/api/v1
EOF
  chmod 0640 /etc/pms-gateway/router.env
fi

# Certificates are renewed independently by certbot. Reload Nginx after a
# successful renewal so the new certificate is served without a reboot.
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -m 0755 "$SCRIPT_DIR/reload-nginx.sh" /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

systemctl daemon-reload
systemctl enable --now frps.service oauth2-proxy-caiwu.service pms-gateway-router.service

echo "installed frps ${FRP_VERSION}, oauth2-proxy ${OAUTH_VERSION} and the dynamic gateway router"
echo "after the wildcard certificate is issued once, run: sudo $SCRIPT_DIR/install-wildcard-entry.sh"
systemctl --no-pager --full status frps.service oauth2-proxy-caiwu.service pms-gateway-router.service | sed -n '1,54p'
