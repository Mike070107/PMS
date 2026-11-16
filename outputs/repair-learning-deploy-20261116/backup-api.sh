#!/bin/bash
set -euo pipefail
ROOT=/opt/pms-repair/apps
BK=/opt/pms-backups/api
PKG=$BK/pms-api-rollback-20261116-120900.tar.gz
[ "$(readlink -f "$ROOT/api")" = /opt/pms-repair/apps/api ]
[ -f "$ROOT/api/dist/release.json" ]
[ ! -e "$PKG" ]
exec 9>/opt/pms-backups/pms-deploy-api.lock
flock -n 9
node -e 'const r=require("/opt/pms-repair/apps/api/dist/release.json"); if(r.commit!=="c0dcec1a98becf32bbd16d0e094e982080effb1e")process.exit(1); console.log(JSON.stringify(r))'
STAGE=$(mktemp -d "$BK/rollback-marker.XXXXXX")
mkdir "$STAGE/api"
printf dist-only-v1 > "$STAGE/api/.pms-fast-release"
tar -czf "$PKG" -C "$ROOT" api/dist api/package.json api/ecosystem.config.cjs -C "$STAGE" api/.pms-fast-release
tar -tzf "$PKG" | python3 -c 'import sys; p=sys.stdin.read().splitlines(); assert "api/.pms-fast-release" in p; assert "api/dist/main.js" in p; assert not any(x.endswith("/.env") or "/node_modules/" in x for x in p); print("rollback members verified",len(p))'
sha256sum "$PKG"
echo "Rollback snapshot created; deployment not yet run. Marker directory intentionally retained: $STAGE"
