#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/opt/self-mail"
APP_USER="catchall"
MAILDIR_ROOT="/home/${APP_USER}/Maildir"

ROOT_DOMAIN="${ROOT_DOMAIN:-}"
PANEL_DOMAIN="${PANEL_DOMAIN:-}"
MX_TARGET="${MX_TARGET:-}"
LE_EMAIL="${LE_EMAIL:-}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"

usage() {
  cat <<EOF
Kullanim:
  sudo bash scripts/install-vps.sh [opsiyonlar]

Opsiyonlar:
  --root-domain <domain.com>
  --panel-domain <mail.domain.com>
  --mx-target <mail.domain.com>
  --le-email <admin@domain.com>
  --non-interactive

Ornek (tam otomatik):
  ROOT_DOMAIN=domain.com PANEL_DOMAIN=mail.domain.com MX_TARGET=mail.domain.com LE_EMAIL=admin@domain.com NON_INTERACTIVE=true \\
  sudo bash scripts/install-vps.sh --non-interactive
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root-domain)
      ROOT_DOMAIN="${2:-}"
      shift 2
      ;;
    --panel-domain)
      PANEL_DOMAIN="${2:-}"
      shift 2
      ;;
    --mx-target)
      MX_TARGET="${2:-}"
      shift 2
      ;;
    --le-email)
      LE_EMAIL="${2:-}"
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Bilinmeyen arguman: $1"
      usage
      exit 1
      ;;
  esac
done

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

normalize() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | xargs
}

prompt_if_empty() {
  local var_name="$1"
  local prompt_text="$2"
  local current_value="${!var_name:-}"

  if [[ -n "$current_value" ]]; then
    return 0
  fi

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    echo "Eksik zorunlu parametre: $var_name"
    exit 1
  fi

  if [[ -r /dev/tty ]]; then
    read -rp "$prompt_text" "$var_name" </dev/tty
  elif [[ -t 0 ]]; then
    read -rp "$prompt_text" "$var_name"
  else
    echo "Interaktif giriş alınamadı. Parametreleri --root-domain/--panel-domain ile verin."
    exit 1
  fi
}

ROOT_DOMAIN="$(normalize "$ROOT_DOMAIN")"
PANEL_DOMAIN="$(normalize "$PANEL_DOMAIN")"
MX_TARGET="$(normalize "$MX_TARGET")"
LE_EMAIL="$(normalize "$LE_EMAIL")"

prompt_if_empty ROOT_DOMAIN "Alias email domaini (örn domain.com): "
prompt_if_empty PANEL_DOMAIN "Web panel domaini (örn mail.domain.com): "

if [[ -z "$MX_TARGET" ]]; then
  MX_TARGET="$PANEL_DOMAIN"
fi

ROOT_DOMAIN="$(normalize "$ROOT_DOMAIN")"
PANEL_DOMAIN="$(normalize "$PANEL_DOMAIN")"
MX_TARGET="$(normalize "$MX_TARGET")"

if [[ -z "$ROOT_DOMAIN" || -z "$PANEL_DOMAIN" || -z "$MX_TARGET" ]]; then
  echo "Domain alanları boş olamaz."
  exit 1
fi

echo "[1/10] Sistem paketleri kuruluyor..."
export DEBIAN_FRONTEND=noninteractive
apt update
apt install -y nginx postfix certbot python3-certbot-nginx ufw dnsutils curl ca-certificates gnupg

echo "[2/10] Node.js 20 LTS kuruluyor..."
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -Eq '^v(20|21|22)\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "[3/10] Catch-all kullanıcı/Maildir hazırlanıyor..."
id -u "$APP_USER" >/dev/null 2>&1 || useradd -m -s /usr/sbin/nologin "$APP_USER"
mkdir -p "${MAILDIR_ROOT}/new" "${MAILDIR_ROOT}/cur" "${MAILDIR_ROOT}/tmp"
chown -R "$APP_USER:$APP_USER" "/home/${APP_USER}"

echo "[4/10] Postfix catch-all ayarlanıyor..."
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

echo "[5/10] DNS doğrulaması"
echo "- Sunucu IP: ${SERVER_IP:-bulunamadı}"
echo "- ${PANEL_DOMAIN} A kayıtları: ${A_RECORDS:-yok}"
echo "- ${ROOT_DOMAIN} MX kayıtları: ${MX_RECORDS:-yok}"

DNS_OK="false"
if [[ -n "$SERVER_IP" ]] && echo "$A_RECORDS" | grep -qw "$SERVER_IP" && echo "$MX_RECORDS" | grep -qw "$MX_TARGET"; then
  DNS_OK="true"
fi

if [[ "$DNS_OK" != "true" ]]; then
  echo ""
  echo "DNS henüz tam hazır değil. Şu kayıtları doğrulayın:"
  echo "- A  ${PANEL_DOMAIN} -> ${SERVER_IP:-SUNUCU_IP}"
  echo "- MX ${ROOT_DOMAIN} -> ${MX_TARGET}"

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    echo "Non-interactive modda DNS hatası olduğu için kurulum durduruldu."
    exit 1
  fi

  if [[ -r /dev/tty ]]; then
    read -rp "DNS düzeltildi mi? Yeniden kontrol etmek için Enter'a basın..." _ </dev/tty
  elif [[ -t 0 ]]; then
    read -rp "DNS düzeltildi mi? Yeniden kontrol etmek için Enter'a basın..." _
  else
    echo "Interaktif doğrulama mümkün değil. Parametreleri düzelttikten sonra scripti tekrar çalıştırın."
    exit 1
  fi

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

echo "[6/10] Node uygulaması kuruluyor..."
cd "$PROJECT_DIR"
npm install

if [[ ! -f ".env" ]]; then
  cp .env.example .env
fi

grep -q '^MAILDIR_ROOT=' .env && sed -i "s|^MAILDIR_ROOT=.*|MAILDIR_ROOT=${MAILDIR_ROOT}|" .env || echo "MAILDIR_ROOT=${MAILDIR_ROOT}" >> .env
grep -q '^PORT=' .env && sed -i "s|^PORT=.*|PORT=3000|" .env || echo "PORT=3000" >> .env

echo "[7/10] PM2 hazırlanıyor..."
npm install -g pm2
pm2 start ecosystem.config.js --update-env
pm2 save
pm2 startup systemd -u root --hp /root || true

echo "[8/10] Nginx reverse proxy ayarlanıyor..."
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
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

echo "[9/10] SSL (Let's Encrypt) kuruluyor..."
if [[ -n "$LE_EMAIL" ]]; then
  certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect
else
  certbot --nginx -d "$PANEL_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi

echo "[10/10] Firewall ve son kontroller..."
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
