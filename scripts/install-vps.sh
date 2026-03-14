#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/opt/self-mail"
APP_USER="catchall"
MAILDIR_ROOT="/home/${APP_USER}/Maildir"

if [[ "$EUID" -ne 0 ]]; then
  echo "Bu script root ile çalışmalı. Örn: sudo bash scripts/install-vps.sh"
  exit 1
fi

if [[ ! -f "${PROJECT_DIR}/package.json" ]]; then
  if [[ -f "./package.json" ]]; then
    PROJECT_DIR="$(pwd)"
  else
    echo "Proje dizini bulunamadı. /opt/self-mail altında çalıştırın veya scripti proje içinden çalıştırın."
    exit 1
  fi
fi

read -rp "Alias email domaini (örn domain.com): " ROOT_DOMAIN
read -rp "Web panel domaini (örn mail.domain.com): " PANEL_DOMAIN
read -rp "MX hedefi (boş bırakılırsa panel domain kullanılır): " MX_TARGET
read -rp "Let's Encrypt e-posta (opsiyonel): " LE_EMAIL

ROOT_DOMAIN="$(echo "$ROOT_DOMAIN" | tr '[:upper:]' '[:lower:]' | xargs)"
PANEL_DOMAIN="$(echo "$PANEL_DOMAIN" | tr '[:upper:]' '[:lower:]' | xargs)"
MX_TARGET="$(echo "${MX_TARGET:-$PANEL_DOMAIN}" | tr '[:upper:]' '[:lower:]' | xargs)"
LE_EMAIL="$(echo "$LE_EMAIL" | tr '[:upper:]' '[:lower:]' | xargs)"

if [[ -z "$ROOT_DOMAIN" || -z "$PANEL_DOMAIN" || -z "$MX_TARGET" ]]; then
  echo "Domain alanları boş olamaz."
  exit 1
fi

echo "[1/9] Sistem paketleri kuruluyor..."
export DEBIAN_FRONTEND=noninteractive
apt update
apt install -y nginx postfix nodejs npm certbot python3-certbot-nginx ufw dnsutils curl ca-certificates

echo "[2/9] Catch-all kullanıcı/Maildir hazırlanıyor..."
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$APP_USER"
mkdir -p "${MAILDIR_ROOT}/new" "${MAILDIR_ROOT}/cur" "${MAILDIR_ROOT}/tmp"
chown -R "$APP_USER:$APP_USER" "/home/${APP_USER}"

echo "[3/9] Postfix catch-all ayarlanıyor..."
postconf -e "myhostname = ${PANEL_DOMAIN}"
postconf -e "virtual_alias_domains = ${ROOT_DOMAIN}"
postconf -e "virtual_alias_maps = regexp:/etc/postfix/virtual_alias"
postconf -e "home_mailbox = Maildir/"

cat >/etc/postfix/virtual_alias <<EOF
/^.+@${ROOT_DOMAIN//./\\.}$/ ${APP_USER}
EOF

systemctl enable postfix
systemctl restart postfix

SERVER_IP="$(curl -4 -s https://api.ipify.org || true)"
A_RECORDS="$(dig +short A "$PANEL_DOMAIN" | tr '\n' ' ' | xargs)"
MX_RECORDS="$(dig +short MX "$ROOT_DOMAIN" | awk '{print $2}' | sed 's/\.$//' | tr '\n' ' ' | xargs)"

echo "[4/9] DNS doğrulaması"
echo "- Sunucu IP: ${SERVER_IP:-bulunamadı}"
echo "- ${PANEL_DOMAIN} A kayıtları: ${A_RECORDS:-yok}"
echo "- ${ROOT_DOMAIN} MX kayıtları: ${MX_RECORDS:-yok}"

DNS_OK="false"
if [[ -n "$SERVER_IP" ]] && echo "$A_RECORDS" | grep -qw "$SERVER_IP" && echo "$MX_RECORDS" | grep -qw "$MX_TARGET"; then
  DNS_OK="true"
fi

if [[ "$DNS_OK" != "true" ]]; then
  echo ""
  echo "DNS henüz tam hazır değil. Devam etmeden önce şu kayıtları düzeltin:"
  echo "- A  ${PANEL_DOMAIN} -> ${SERVER_IP:-SUNUCU_IP}"
  echo "- MX ${ROOT_DOMAIN} -> ${MX_TARGET}"
  read -rp "DNS düzeltildi mi? Yeniden kontrol etmek için Enter'a basın..." _

  A_RECORDS="$(dig +short A "$PANEL_DOMAIN" | tr '\n' ' ' | xargs)"
  MX_RECORDS="$(dig +short MX "$ROOT_DOMAIN" | awk '{print $2}' | sed 's/\.$//' | tr '\n' ' ' | xargs)"

  if [[ -n "$SERVER_IP" ]] && echo "$A_RECORDS" | grep -qw "$SERVER_IP" && echo "$MX_RECORDS" | grep -qw "$MX_TARGET"; then
    DNS_OK="true"
  fi
fi

if [[ "$DNS_OK" != "true" ]]; then
  echo "DNS doğrulaması başarısız. Kayıtlar tam oturunca scripti tekrar çalıştırın."
  exit 1
fi

echo "[5/9] Node uygulaması kuruluyor..."
cd "$PROJECT_DIR"
npm install

if [[ ! -f ".env" ]]; then
  cp .env.example .env
fi

sed -i "s|^MAILDIR_ROOT=.*|MAILDIR_ROOT=${MAILDIR_ROOT}|" .env || true
sed -i "s|^PORT=.*|PORT=3000|" .env || true

echo "[6/9] PM2 hazırlanıyor..."
npm install -g pm2
pm2 start ecosystem.config.js --update-env
pm2 save
pm2 startup systemd >/tmp/selfmail_pm2_startup.txt || true
if grep -q "sudo" /tmp/selfmail_pm2_startup.txt; then
  bash -c "$(grep -m1 'sudo' /tmp/selfmail_pm2_startup.txt | sed 's/^\[PM2\] //')" || true
fi

echo "[7/9] Nginx reverse proxy ayarlanıyor..."
cat >/etc/nginx/sites-available/mailpanel <<EOF
server {
    listen 80;
    server_name ${PANEL_DOMAIN};

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

ln -sf /etc/nginx/sites-available/mailpanel /etc/nginx/sites-enabled/mailpanel
nginx -t
systemctl enable nginx
systemctl reload nginx

echo "[8/9] SSL (Let's Encrypt) kuruluyor..."
if [[ -n "$LE_EMAIL" ]]; then
  certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect
else
  certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi

echo "[9/9] Firewall ve son kontroller..."
ufw allow 22 || true
ufw allow 25 || true
ufw allow 80 || true
ufw allow 443 || true
ufw --force enable || true

systemctl restart postfix
systemctl restart nginx
pm2 restart self-mail || true

echo ""
echo "Kurulum tamamlandı ✅"
echo "Panel: https://${PANEL_DOMAIN}"
echo "İlk açılışta setup wizard gelecek; admin kullanıcı/şifreyi orada tek seferlik oluşturun."
echo "Bu admin dışında başka admin oluşturulamaz."
