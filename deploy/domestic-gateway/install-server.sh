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

OIDC_CLIENT_ID=$(read_env EXTERNAL_OIDC_CLIENT_ID)
OIDC_CLIENT_SECRET=$(read_env EXTERNAL_OIDC_CLIENT_SECRET)
if [[ -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  echo "EXTERNAL_OIDC_CLIENT_ID/SECRET is missing" >&2
  exit 1
fi

install -d -m 0750 /etc/pms-gateway /var/log/pms-gateway
if [[ ! -s /etc/pms-gateway/frp-token ]]; then
  openssl rand -hex 32 > /etc/pms-gateway/frp-token
fi
if [[ ! -s /etc/pms-gateway/oauth-cookie-secret ]]; then
  openssl rand 32 > /etc/pms-gateway/oauth-cookie-secret
fi
printf '%s' "$OIDC_CLIENT_SECRET" > /etc/pms-gateway/oidc-client-secret
chmod 0600 /etc/pms-gateway/frp-token /etc/pms-gateway/oauth-cookie-secret /etc/pms-gateway/oidc-client-secret

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

install -m 0640 "$SCRIPT_DIR/frps.toml.example" /etc/pms-gateway/frps.toml
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

# Certificates are renewed independently by certbot. Reload Nginx after a
# successful renewal so the new certificate is served without a reboot.
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -m 0755 "$SCRIPT_DIR/reload-nginx.sh" /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

systemctl daemon-reload
systemctl enable --now frps.service oauth2-proxy-caiwu.service

echo "installed frps ${FRP_VERSION} and oauth2-proxy ${OAUTH_VERSION}"
systemctl --no-pager --full status frps.service oauth2-proxy-caiwu.service | sed -n '1,36p'
