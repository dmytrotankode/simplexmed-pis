#!/usr/bin/env bash
# ==============================================================================
# SimplexMed ПІС — викатка на dev-сервер (pm2), як розгорнуто зараз:
#   сервер accuracy-mfx-dev (188.245.104.34), каталог /root/simplex-patient-dev,
#   pm2-процес simplex-dev-patient (venv/bin/gunicorn -c backend/gunicorn.conf.py), nginx -> 127.0.0.1:3122
#   (my-dev.simplex-med.com і my.simplex-med.com).
#
# Запуск з кореня репозиторію (Git Bash / Linux):  bash pis/deploy/deploy-pm2.sh
# .env на сервері (/root/simplex-patient-dev/.env) скрипт НЕ змінює — шаблон у pis/deploy/.env.example.
# ==============================================================================
set -euo pipefail

HOST="${PIS_DEPLOY_HOST:-accuracy-mfx-dev}"
DIR="${PIS_DEPLOY_DIR:-/root/simplex-patient-dev}"
PM2_NAME="${PIS_PM2_NAME:-simplex-dev-patient}"
ARCHIVE="$(mktemp -t pis-release-XXXX.tgz)"

# НСЗУ змінює ТВ ПІС новими наказами: попередження, якщо опубліковано нову редакцію або змінився PIS API (викатку не зупиняє)
echo "=== [0/6] Актуальність ТВ ПІС і PIS API"
PY=""; for c in python3 python; do if command -v "$c" >/dev/null && "$c" -c "" 2>/dev/null; then PY=$c; break; fi; done
if [ -n "$PY" ]; then
  PYTHONIOENCODING=utf-8 "$PY" pis/tools/check_tz_updates.py || \
    echo "!!! УВАГА: технічні вимоги або PIS API змінилися — потрібен аудит ПІС (див. pis/README.md)"
fi

echo "=== [1/6] Архів закомміченого коду ($(git rev-parse --short HEAD))"
git archive --format=tar.gz -o "$ARCHIVE" HEAD pis/backend pis/web pis/tools
scp -q "$ARCHIVE" "$HOST:/tmp/pis-release.tgz"
rm -f "$ARCHIVE"

ssh "$HOST" "DIR='$DIR' PM2_NAME='$PM2_NAME' bash -s" <<'REMOTE'
set -euo pipefail
cd "$DIR"
test -f .env || { echo "Немає $DIR/.env — створіть за pis/deploy/.env.example"; exit 1; }
grep -q '^PIS_TOKEN_KEY=.' .env || { echo "У .env немає PIS_TOKEN_KEY"; exit 1; }

echo "=== [2/6] Резервна копія"
TS=$(date +%Y%m%d-%H%M%S)
tar czf "/root/$(basename "$DIR")-backup-$TS.tgz" --exclude=venv --exclude=__pycache__ --exclude='*.sqlite3*' \
    --exclude=web/lib -C "$(dirname "$DIR")" "$(basename "$DIR")"

echo "=== [3/6] Розпакування у staging і перевірка запуску"
STAGE=$(mktemp -d)
tar xzf /tmp/pis-release.tgz -C "$STAGE"
venv/bin/python tools/fetch_euscp.py --check >/dev/null 2>&1 || true
(cd "$STAGE/pis/backend" && PIS_ENV_FILE="$DIR/.env" PIS_REGISTRY_DB="$STAGE/test.sqlite3" PIS_REGISTRY_REFRESH=0 \
    "$DIR/venv/bin/python" -c "import app; c=app.app.test_client(); assert c.get('/health').status_code==200; print('staging OK')")

echo "=== [4/6] Міграції бази ПІС (ідемпотентні)"
for f in "$STAGE"/pis/backend/migrations/*.sql; do
  (cd "$STAGE/pis/backend" && PIS_ENV_FILE="$DIR/.env" "$DIR/venv/bin/python" -c "
import os, sys
from dotenv import load_dotenv
load_dotenv(os.environ['PIS_ENV_FILE'])
import pis_service
c = pis_service.get_db(); c.autocommit = True
c.cursor().execute(open('$f', encoding='utf-8').read()); c.close()
print('migration ok: $(basename "$f")')")
done

echo "=== [5/6] Заміна коду і бібліотеки підпису"
rm -rf backend/__pycache__ backend/ehealth_pis/__pycache__
cp -a "$STAGE/pis/backend/." backend/
mkdir -p tools web
cp -a "$STAGE/pis/tools/." tools/
cp -a "$STAGE/pis/web/." web/
venv/bin/python tools/fetch_euscp.py --check >/dev/null 2>&1 || venv/bin/python tools/fetch_euscp.py
test -x venv/bin/gunicorn || venv/bin/pip install -q "gunicorn==23.0.0"
rm -rf "$STAGE" /tmp/pis-release.tgz

echo "=== [6/6] Перезапуск $PM2_NAME"
pm2 restart "$PM2_NAME" --update-env >/dev/null
sleep 3
curl -fsS http://127.0.0.1:3122/health && echo
ss -ltnp | grep ':3122' || true
REMOTE

echo "Готово. Перевірте: https://my-dev.simplex-med.com/health"
echo "redirect-ehealth.js на https://simplex-med.com/js/ оновлюється окремо (інший хостинг, 195.234.4.57)."
