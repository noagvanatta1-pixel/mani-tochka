#!/bin/bash
# Копия базы на второй сервер (Франкфурт). Запуск на МОСКОВСКОМ сервере:
#   bash offsite.sh IP_ФРАНКФУРТА
# Скрипт создаёт ключ и показывает одну команду, которую нужно вставить во Франкфурте.
# Этот ключ умеет ТОЛЬКО записывать файл копии, больше ничего.
set -e
FRA="$1"
[ -n "$FRA" ] || { echo "Укажите IP второго сервера: bash offsite.sh 89.125.168.140"; exit 1; }
KEY=/root/.ssh/mani_backup
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C mani-backup -f "$KEY"
echo "$FRA" > /etc/mani-offsite-host

cat > /etc/cron.daily/mani-offsite <<'OFF'
#!/bin/sh
# запускается после mani-backup (имена по алфавиту)
HOST=$(cat /etc/mani-offsite-host 2>/dev/null) || exit 0
F="/var/backups/mani/mani-$(date +%F).db"
[ -f "$F" ] || exit 0
ssh -i /root/.ssh/mani_backup -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new root@"$HOST" < "$F" || logger -t mani-offsite "копия не отправилась"
OFF
chmod +x /etc/cron.daily/mani-offsite

PUB=$(cat "$KEY.pub")
echo
echo "Готово на этом сервере. Теперь ВО ФРАНКФУРТЕ (89.125.168.140) вставьте ОДНУ команду:"
echo
echo "mkdir -p /root/.ssh && echo 'restrict,command=\"mkdir -p /var/backups/mani-offsite && cat > /var/backups/mani-offsite/mani-\$(date +%F).db && find /var/backups/mani-offsite -type f -mtime +30 -delete\" $PUB' >> /root/.ssh/authorized_keys"
echo
echo "Потом проверьте здесь отправку:  sh /etc/cron.daily/mani-backup; sh /etc/cron.daily/mani-offsite  и во Франкфурте:  ls -la /var/backups/mani-offsite"
