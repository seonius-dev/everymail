const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const statusEl = document.getElementById("status");

loginBtn.addEventListener("click", login);
passwordEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    login();
  }
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "mt-3 text-sm text-red-600" : "mt-3 text-sm text-slate-600";
}

async function login() {
  setStatus("Giriş yapılıyor...");

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: usernameEl.value.trim(),
        password: passwordEl.value,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Giriş başarısız");
    }

    setStatus("Giriş başarılı.");
    window.location.href = "/";
  } catch (error) {
    setStatus(error.message || "Giriş başarısız", true);
  }
}
