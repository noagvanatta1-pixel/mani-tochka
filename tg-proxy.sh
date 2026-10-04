#!/usr/bin/env bash
# Посредник к Telegram API для сервера «Копилка» (ставится на сервер ЗА ПРЕДЕЛАМИ РФ).
# Запуск: curl -fsSL https://raw.githubusercontent.com/noagvanatta1-pixel/mani-tochka/main/tg-proxy.sh | bash
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
echo "==> Пакеты"
apt-get -o DPkg::Lock::Timeout=600 update -y
apt-get -o DPkg::Lock::Timeout=600 install -y caddy curl openssl ufw

IP="$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)"
HOST="$(echo "$IP" | tr . -).sslip.io"

SECRET_FILE=/etc/tgproxy.secret
[ -f "$SECRET_FILE" ] || { openssl rand -hex 16 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; }
SECRET="$(cat "$SECRET_FILE")"

echo "==> Настройка Caddy ($HOST)"
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
    @tg path /$SECRET/bot*
    handle @tg {
        uri strip_prefix /$SECRET
        reverse_proxy https://api.telegram.org {
            header_up Host api.telegram.org
        }
    }
    respond 404
}
CADDY
systemctl enable caddy >/dev/null
systemctl restart caddy

SSHP="$(ss -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]}' | sort -u | tr '\n' ' ')"
for P in 22 $SSHP; do ufw allow "$P"/tcp >/dev/null; done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Проверка (через пару секунд, сертификат выпускается)"
sleep 8
CODE="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$HOST/$SECRET/bot0:test/getMe" || true)"
echo "Ответ посредника: $CODE (ожидаем 401 или 404 от Telegram — значит, связь есть)"
echo
echo "Адрес посредника для основного сервера:"
echo "TG_API_BASE=https://$HOST/$SECRET"
