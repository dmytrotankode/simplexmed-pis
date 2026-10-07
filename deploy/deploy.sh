#!/usr/bin/env bash
# ==============================================================================
# SimplexMed 2.0 — Patient Cabinet Deployment Script
# Target Host: 116.203.211.35 (Hetzner MFX Server)
# Target Domains: my-dev.simplex-med.com / my.simplex-med.com
# ==============================================================================

set -e

DEPLOY_DIR="/var/www/simplex-pis"
NGINX_CONF="/etc/nginx/sites-available/my-simplex-med.conf"

if [ ! -f "$DEPLOY_DIR/.env" ]; then
    echo "Немає $DEPLOY_DIR/.env — створіть його за шаблоном pis/deploy/.env.example (chmod 600)"
    exit 1
fi

echo "=== [1/5] Створення цільових директорій ==="
mkdir -p "$DEPLOY_DIR/backend"
mkdir -p "$DEPLOY_DIR/web"

echo "=== [2/5] Копіювання файлів бекенду та фронтенду ==="
cp pis/backend/*.py "$DEPLOY_DIR/backend/"
cp pis/backend/*.sql "$DEPLOY_DIR/backend/"
rm -rf "$DEPLOY_DIR/backend/ehealth_pis" "$DEPLOY_DIR/backend/migrations"
cp -r pis/backend/ehealth_pis pis/backend/migrations "$DEPLOY_DIR/backend/"
echo "!!! Застосуйте нові міграції з $DEPLOY_DIR/backend/migrations до бази ПІС (psql -f ...)"
# Бібліотека підпису ІІТ (пропрієтарна, не в git): завантаження з перевіркою SHA-256
python3 pis/tools/fetch_euscp.py
cp -r pis/web/. "$DEPLOY_DIR/web/"

echo "=== [3/5] Встановлення залежностей Python ==="
pip3 install flask flask-cors psycopg2-binary python-dotenv cryptography

echo "=== [4/5] Налаштування systemd сервісу ==="
cp pis/deploy/simplex-pis.service /etc/systemd/system/simplex-pis.service
systemctl daemon-reload
systemctl enable simplex-pis
systemctl restart simplex-pis

echo "=== [5/5] Налаштування Nginx ==="
cp pis/deploy/nginx_my.simplex-med.com.conf "$NGINX_CONF"
if [ ! -f /etc/nginx/sites-enabled/my-simplex-med.conf ]; then
    ln -s "$NGINX_CONF" /etc/nginx/sites-enabled/
fi

nginx -t
systemctl reload nginx

echo "=========================================================="
echo "  Кабінет пацієнта успішно розгорнуто!"
echo "  URL Dev:  https://my-dev.simplex-med.com"
echo "  URL Prod: https://my.simplex-med.com"
echo "  PIS API:  https://my-dev.simplex-med.com/api/"
echo "  Health:   https://my-dev.simplex-med.com/health"
echo "=========================================================="
