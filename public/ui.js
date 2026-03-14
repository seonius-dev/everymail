const emailInput = document.getElementById("emailInput");
const openBtn = document.getElementById("openBtn");
const statusEl = document.getElementById("status");
const mailListEl = document.getElementById("mailList");
const mailMetaEl = document.getElementById("mailMeta");
const mailBodyEl = document.getElementById("mailBody");
const attachmentsEl = document.getElementById("attachments");
const logoutBtn = document.getElementById("logoutBtn");

let selectedInbox = "";
let selectedMessageId = "";

bootstrap();

openBtn.addEventListener("click", openInbox);
logoutBtn.addEventListener("click", logout);
emailInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    openInbox();
  }
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "mt-3 text-sm text-red-600" : "mt-3 text-sm text-slate-500";
}

function resetMailView() {
  selectedMessageId = "";
  mailMetaEl.innerHTML = "";
  mailBodyEl.innerHTML = "";
  attachmentsEl.innerHTML = "";
}

function renderMailList(items) {
  if (!items.length) {
    mailListEl.innerHTML = '<div class="text-sm text-slate-500">No mails found.</div>';
    return;
  }

  mailListEl.innerHTML = items
    .map((mail) => {
      const dateText = mail.date ? new Date(mail.date).toLocaleString() : "-";
      const selectedClass = selectedMessageId === mail.id ? "border-slate-900" : "border-slate-200";

      return `
        <button
          class="w-full text-left border rounded-lg p-3 hover:bg-slate-50 ${selectedClass}"
          data-message-id="${mail.id}"
        >
          <div class="text-sm font-medium truncate">${escapeHtml(mail.subject || "(no subject)")}</div>
          <div class="text-xs text-slate-500 truncate">From: ${escapeHtml(mail.from || "")}</div>
          <div class="text-xs text-slate-500 truncate">To: ${escapeHtml(mail.to || "")}</div>
          <div class="text-xs text-slate-400 mt-1">${escapeHtml(dateText)}</div>
          ${mail.hasAttachments ? '<div class="text-xs text-slate-700 mt-1">Attachment: ' + mail.attachmentCount + '</div>' : ""}
        </button>
      `;
    })
    .join("");

  mailListEl.querySelectorAll("button[data-message-id]").forEach((button) => {
    button.addEventListener("click", () => openMessage(button.dataset.messageId));
  });
}

async function openInbox() {
  const email = emailInput.value.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    setStatus("Please enter a valid email address.", true);
    return;
  }

  selectedInbox = email;
  resetMailView();
  mailListEl.innerHTML = "";

  setStatus("Loading inbox...");
  try {
    const response = await fetch(`/api/inbox/${encodeURIComponent(email)}`);
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) {
      throw new Error("Inbox request failed");
    }

    const data = await response.json();
    setStatus(`${data.count} mail found for ${data.inbox}`);
    renderMailList(data.items || []);
  } catch (error) {
    setStatus("Failed to load inbox.", true);
  }
}

async function openMessage(messageId) {
  if (!selectedInbox) {
    return;
  }

  selectedMessageId = messageId;
  setStatus("Loading message...");

  try {
    const response = await fetch(`/api/message/${encodeURIComponent(messageId)}`);
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) {
      throw new Error("Message request failed");
    }

    const data = await response.json();
    renderMessage(data);
    setStatus(`Inbox ${selectedInbox} loaded`);
  } catch (error) {
    setStatus("Failed to load message.", true);
  }
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

function renderMessage(data) {
  mailMetaEl.innerHTML = `
    <div><span class="font-medium">From:</span> ${escapeHtml(data.from || "")}</div>
    <div><span class="font-medium">To:</span> ${escapeHtml(data.to || "")}</div>
    <div><span class="font-medium">Subject:</span> ${escapeHtml(data.subject || "")}</div>
    <div><span class="font-medium">Date:</span> ${escapeHtml(
      data.date ? new Date(data.date).toLocaleString() : "-"
    )}</div>
  `;

  mailBodyEl.innerHTML = data.html || "";

  if (!Array.isArray(data.attachments) || !data.attachments.length) {
    attachmentsEl.innerHTML = "";
    return;
  }

  attachmentsEl.innerHTML = `
    <div class="text-sm font-medium mb-1">Attachments</div>
    <div class="flex flex-wrap gap-2">
      ${data.attachments
        .map(
          (att) => `
            <a
              href="${att.downloadUrl}"
              target="_blank"
              class="text-xs border border-slate-300 rounded px-2 py-1 hover:bg-slate-50"
            >
              ${escapeHtml(att.filename || "attachment")}
            </a>
          `
        )
        .join("")}
    </div>
  `;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function bootstrap() {
  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) {
      window.location.href = "/login";
    }
  } catch (_error) {
    window.location.href = "/login";
  }
}
