const domainEl = document.getElementById("domain");
const panelDomainEl = document.getElementById("panelDomain");
const mxTargetEl = document.getElementById("mxTarget");
const sslEmailEl = document.getElementById("sslEmail");
const adminUserEl = document.getElementById("adminUser");
const adminPassEl = document.getElementById("adminPass");
const checkBtn = document.getElementById("checkBtn");
const completeBtn = document.getElementById("completeBtn");
const statusEl = document.getElementById("status");
const reportEl = document.getElementById("report");

checkBtn.addEventListener("click", checkDns);
completeBtn.addEventListener("click", completeSetup);

let dnsValidated = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "mt-4 text-sm text-red-600" : "mt-4 text-sm text-slate-600";
}

function payload() {
  const panelDomain = panelDomainEl.value.trim().toLowerCase();
  const mxTarget = mxTargetEl.value.trim().toLowerCase() || panelDomain;

  return {
    domain: domainEl.value.trim().toLowerCase(),
    panelDomain,
    mxTarget,
    letsencryptEmail: sslEmailEl.value.trim().toLowerCase(),
    adminUsername: adminUserEl.value.trim(),
    adminPassword: adminPassEl.value,
  };
}

async function checkDns() {
  dnsValidated = false;
  completeBtn.disabled = true;
  setStatus("DNS kontrolü yapılıyor...");
  reportEl.textContent = "";

  try {
    const response = await fetch("/api/setup/validate-dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "DNS kontrolü başarısız");
    }

    reportEl.textContent = JSON.stringify(data, null, 2);
    if (data.success) {
      dnsValidated = true;
      completeBtn.disabled = false;
      setStatus("DNS ve MX kayıtları doğru görünüyor.");
    } else {
      setStatus("DNS kontrolleri eksik. Rapora göre düzeltip tekrar deneyin.", true);
    }
  } catch (error) {
    setStatus(error.message || "DNS kontrolü başarısız", true);
  }
}

async function completeSetup() {
  if (!dnsValidated) {
    setStatus("Önce DNS Kontrol Et adımını başarılı tamamlayın.", true);
    return;
  }

  setStatus("Kurulum kaydediliyor...");

  try {
    const response = await fetch("/api/setup/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Kurulum tamamlanamadı");
    }

    setStatus("Kurulum tamamlandı. Şimdi giriş ekranına yönlendiriliyorsunuz.");
    setTimeout(() => {
      window.location.href = "/login";
    }, 1000);
  } catch (error) {
    setStatus(error.message || "Kurulum tamamlanamadı", true);
  }
}
