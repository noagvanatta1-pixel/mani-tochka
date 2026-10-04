#!/usr/bin/env bash
# Установка сервера «Копилка» на чистый Ubuntu 22.04/24.04.
# Запуск: curl -fsSL https://raw.githubusercontent.com/noagvanatta1-pixel/mani-tochka/main/install.sh | bash -s ДОМЕН
# Повторный запуск обновляет приложение до последней версии.
set -euo pipefail

DOMAIN="${1:-}"
REPO="https://github.com/noagvanatta1-pixel/mani-tochka.git"
NODE_VER="v22.14.0"
APP_DIR=/opt/mani
DATA_DIR=/var/lib/mani
ENV_FILE=/etc/mani.env

[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }
[ -n "$DOMAIN" ] || { echo "Укажите домен: ... | bash -s kopilka.website"; exit 1; }

echo "==> Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update -y
apt-get -o DPkg::Lock::Timeout=600 install -y curl git xz-utils caddy sqlite3 ufw ca-certificates

echo "==> Node.js $NODE_VER"
if ! /usr/local/bin/node -v 2>/dev/null | grep -q "$NODE_VER"; then
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
node -v

echo "==> Код приложения"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
mkdir -p "$DATA_DIR"

echo "==> Настройки"
if [ ! -f "$ENV_FILE" ]; then
  printf "Вставьте токен бота от @BotFather (ввод не виден) и нажмите Enter: " > /dev/tty
  read -rs TOKEN < /dev/tty
  echo > /dev/tty
  [ -n "$TOKEN" ] || { echo "Токен пустой"; exit 1; }
  cat > "$ENV_FILE" <<ENVEOF
BOT_TOKEN=$TOKEN
APP_URL=https://$DOMAIN
DATA_DIR=$DATA_DIR
PORT=3000
NODE_ENV=production
BOT_USERNAME=TheSavedMoney_bot
ENVEOF
  chmod 600 "$ENV_FILE"
else
  sed -i "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" "$ENV_FILE"
  grep -q '^BOT_USERNAME=' "$ENV_FILE" || echo "BOT_USERNAME=TheSavedMoney_bot" >> "$ENV_FILE"
fi
# поддержка и секрет для уведомлений об оплате (добавляются один раз)
grep -q '^SUPPORT_TG=' "$ENV_FILE" || echo "SUPPORT_TG=Noagvanatta1" >> "$ENV_FILE"
grep -q '^PAY_SECRET=' "$ENV_FILE" || echo "PAY_SECRET=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"

echo "==> Служба"
cat > /etc/systemd/system/mani.service <<'SVC'
[Unit]
Description=Kopilka Mini App server
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/mani
EnvironmentFile=/etc/mani.env
ExecStart=/usr/local/bin/node /opt/mani/server.js
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload
systemctl enable mani >/dev/null
systemctl restart mani

echo "==> HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl enable caddy >/dev/null
systemctl restart caddy

echo "==> Файрвол"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Ежедневная копия базы (хранится 14 дней)"
cat > /etc/cron.daily/mani-backup <<'BAK'
#!/bin/sh
mkdir -p /var/backups/mani
if [ -f /var/lib/mani/mani.db ]; then
  sqlite3 /var/lib/mani/mani.db ".backup '/var/backups/mani/mani-$(date +%F).db'"
  find /var/backups/mani -name 'mani-*.db' -mtime +14 -delete
fi
BAK
chmod +x /etc/cron.daily/mani-backup

sleep 3
echo
echo "==> Проверка"
systemctl is-active mani
journalctl -u mani -n 5 --no-pager || true
echo
echo "Готово. Откройте https://$DOMAIN (сертификат может появиться через минуту)."
