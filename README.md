# SELF-MAIL

Catch-all email sistemi + web panel.

- `*@domain.com` adreslerinin tamamını kabul eder
- Mailleri `Maildir` formatında saklar
- Web panelde inbox listesi / içerik / attachment görüntüler
- İlk kurulum tek seferliktir, admin hesabı bir kez oluşturulur ve kilitlenir

---

## 1) Hızlı Başlangıç (VPS'te tek komut)

> Sunucu: Ubuntu 22.04 (önerilen)

Önce DNS kayıtlarını panel domaini ve MX için hazırlayın:

- `A   mail.domain.com -> VPS_IP`
- `MX  domain.com -> mail.domain.com`

Sonra VPS'e SSH ile bağlanıp tek komut çalıştırın:

```bash
curl -fsSL https://raw.githubusercontent.com/seonius-dev/everymail/main/scripts/quickstart.sh | sudo bash -s -- https://github.com/seonius-dev/everymail.git main
```

Bu komut kurulum sırasında sizden `domain`, `panel domain` ve gerekirse `MX` bilgilerini ister.

Tam otomatik (non-interactive) kurulum isterseniz:

```bash
curl -fsSL https://raw.githubusercontent.com/seonius-dev/everymail/main/scripts/quickstart.sh | \
ROOT_DOMAIN=domain.com PANEL_DOMAIN=mail.domain.com MX_TARGET=mail.domain.com LE_EMAIL=admin@domain.com NON_INTERACTIVE=true \
sudo -E bash -s -- https://github.com/seonius-dev/everymail.git main --non-interactive
```

Script otomatik olarak:

1. Gerekli paketleri kurar (`nginx`, `postfix`, `node`, `pm2`, `certbot`...)
2. Catch-all `Maildir` altyapısını kurar
3. DNS (A + MX) kontrolü yapar
4. Node uygulamasını ayağa kaldırır
5. Nginx reverse proxy ayarlar
6. Let's Encrypt SSL alır
7. Firewall kurallarını açar

Kurulum akışı DNS doğrulaması geçmeden bir sonraki adıma geçmez.

Kurulum bittiğinde panel adresinizi verir: `https://mail.domain.com`

---

## 2) İlk Açılış (WordPress benzeri setup wizard)

Tarayıcıdan panel domainini açın:

- `https://mail.domain.com`

İlk açılışta setup ekranı gelir. Sırasıyla:

1. Ana domain (`domain.com`)
2. Panel domain (`mail.domain.com`)
3. MX hedef host (`mail.domain.com`)
4. Admin kullanıcı adı + şifre
5. `DNS Kontrol Et`
6. Kontrol başarılıysa `Kurulumu Tamamla`

### Kurulum kilidi

- Kurulum tamamlanınca sistem kilitlenir (`data/setup.lock`)
- İkinci admin oluşturulamaz
- Setup ekranı tekrar açılamaz

---

## 3) Güvenlik Modeli

- Inbox API uçları sadece admin oturumuyla erişilir
- Oturum çerezi `httpOnly` ve `sameSite=lax`
- Panel verileri login olmadan görüntülenemez
- Admin hesabı sadece ilk kurulumda bir kez tanımlanır

---

## 4) Mimari

`internet -> Postfix SMTP -> Maildir -> Node.js API -> Web UI`

---

## 5) Geliştirici Çalıştırma (lokal)

```bash
npm install
npm start
```

Varsayılan:

- App: `http://localhost:3000`
- Maildir: `/home/catchall/Maildir`

`.env.example`:

```env
PORT=3000
MAILDIR_ROOT=/home/catchall/Maildir
MAX_LIST_ITEMS=200
```

---

## 6) Kullanılan Scriptler

- `scripts/quickstart.sh`  
  Repoyu indirir ve ana VPS kurulumunu başlatır

- `scripts/install-vps.sh`  
  Tam otomasyon kurulum (Postfix + Nginx + SSL + PM2 + DNS kontrol)

---

## 7) API Uçları

- `GET /api/health`
- `GET /api/system/status`
- `POST /api/setup/validate-dns`
- `POST /api/setup/complete`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/inbox/:email`
- `GET /api/message/:id`
- `GET /api/message/:id/attachment/:index`

---

## 8) GitHub Repo'ya Push

Bu ortamdan doğrudan hesabınıza push yapamıyorum; aşağıdaki komutları siz çalıştırın:

```bash
git init
git add .
git commit -m "feat: one-command VPS installer, setup lock, admin auth, dns+mx wizard"
git branch -M main
git remote add origin https://github.com/<GITHUB_KULLANICI>/<REPO_ADI>.git
git push -u origin main
```

---

## 9) Notlar

- DNS propagasyonu gecikirse script DNS adımında sizi bekletir.
- 2 GB RAM için `MAX_LIST_ITEMS` değerini düşük tutun (`100-300`).
- Büyük mailbox için ileride indeksleme (SQLite/JSON index) eklenebilir.
