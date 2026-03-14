const crypto = require("crypto");
const dns = require("dns").promises;
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const fs = require("fs-extra");
const helmet = require("helmet");
const https = require("https");
const path = require("path");
const sanitizeHtml = require("sanitize-html");
const { simpleParser } = require("mailparser");

require("dotenv").config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const SETUP_PATH = path.join(DATA_DIR, "setup.json");
const SETUP_LOCK_PATH = path.join(DATA_DIR, "setup.lock");
const DEFAULT_MAILDIR_ROOT = process.env.MAILDIR_ROOT || "/home/catchall/Maildir";
const MAX_LIST_ITEMS = Number(process.env.MAX_LIST_ITEMS || 200);
const MAIL_FOLDERS = ["new", "cur"];

const parseCache = new Map();

let setupState = loadSetupState();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    name: "selfmail.sid",
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

function getSessionSecret() {
  return setupState?.sessionSecret || process.env.SESSION_SECRET || "change-this-secret";
}

function loadSetupState() {
  try {
    if (!fs.existsSync(SETUP_PATH)) {
      return null;
    }

    return fs.readJsonSync(SETUP_PATH);
  } catch (error) {
    console.error("Failed to load setup state:", error);
    return null;
  }
}

function isSetupStateValid(state) {
  return Boolean(
    state?.adminUsername &&
      state?.adminPasswordHash &&
      state?.domain &&
      state?.panelDomain &&
      state?.mxTarget &&
      state?.sessionSecret
  );
}

function isSetupComplete() {
  return isSetupStateValid(setupState);
}

function isSetupLocked() {
  return fs.existsSync(SETUP_LOCK_PATH) || isSetupComplete();
}

function getMaildirRoot() {
  return setupState?.maildirRoot || DEFAULT_MAILDIR_ROOT;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validateDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  const domainRegex = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
  return domainRegex.test(domain) ? domain : "";
}

function requireSetup(req, res, next) {
  if (!isSetupComplete()) {
    return res.status(403).json({ error: "Setup is not complete" });
  }

  return next();
}

function requireAuth(req, res, next) {
  if (!isSetupComplete()) {
    return res.status(403).json({ error: "Setup is not complete" });
  }

  if (!req.session?.isAdmin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

function pickMessageFiles() {
  const files = [];

  for (const folder of MAIL_FOLDERS) {
    const fullPath = path.join(getMaildirRoot(), folder);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const folderItems = fs.readdirSync(fullPath, { withFileTypes: true });
    for (const item of folderItems) {
      if (!item.isFile()) {
        continue;
      }

      const filePath = path.join(fullPath, item.name);
      const stat = fs.statSync(filePath);
      files.push({
        id: `${folder}:${item.name}`,
        filePath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_LIST_ITEMS);
}

function getAddressList(addressObject) {
  if (!addressObject || !Array.isArray(addressObject.value)) {
    return [];
  }

  return addressObject.value
    .map((entry) => normalizeEmail(entry.address))
    .filter(Boolean);
}

function messageHasRecipient(parsed, email) {
  const targets = [
    ...getAddressList(parsed.to),
    ...getAddressList(parsed.cc),
    ...getAddressList(parsed.bcc),
    normalizeEmail(parsed.headers.get("delivered-to")),
    normalizeEmail(parsed.headers.get("x-original-to")),
  ].filter(Boolean);

  return targets.includes(email);
}

async function readAndParseMessage(messageMeta) {
  const cached = parseCache.get(messageMeta.id);
  if (cached && cached.mtimeMs === messageMeta.mtimeMs) {
    return cached.parsed;
  }

  const raw = await fs.readFile(messageMeta.filePath);
  const parsed = await simpleParser(raw);

  parseCache.set(messageMeta.id, {
    mtimeMs: messageMeta.mtimeMs,
    parsed,
  });

  return parsed;
}

function toSummary(messageMeta, parsed) {
  return {
    id: messageMeta.id,
    from: parsed.from?.text || "(unknown)",
    to: parsed.to?.text || "",
    subject: parsed.subject || "(no subject)",
    date: parsed.date || null,
    hasAttachments: (parsed.attachments || []).length > 0,
    attachmentCount: (parsed.attachments || []).length,
  };
}

function htmlFromParsed(parsed) {
  if (parsed.html) {
    return sanitizeHtml(parsed.html, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
      allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        "*": ["style", "class"],
        img: ["src", "alt", "style"],
        a: ["href", "name", "target"],
      },
      allowedSchemes: ["http", "https", "mailto", "data"],
    });
  }

  const text = parsed.text || "";
  return `<pre style=\"white-space:pre-wrap;word-break:break-word\">${escapeHtml(text)}</pre>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getMessageMetaById(messageId) {
  const [folder, fileName] = String(messageId || "").split(":");

  if (!MAIL_FOLDERS.includes(folder) || !fileName) {
    return null;
  }

  const filePath = path.join(getMaildirRoot(), folder, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stat = fs.statSync(filePath);
  return {
    id: `${folder}:${fileName}`,
    filePath,
    mtimeMs: stat.mtimeMs,
  };
}

function httpGetText(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const request = https.get(url, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk;
      });
      response.on("end", () => {
        resolve(String(data || "").trim());
      });
    });

    request.on("error", () => resolve(""));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve("");
    });
  });
}

async function getPublicIPv4() {
  if (process.env.SERVER_PUBLIC_IP) {
    return String(process.env.SERVER_PUBLIC_IP).trim();
  }

  const candidates = [
    "https://api.ipify.org?format=text",
    "https://ifconfig.me/ip",
    "https://checkip.amazonaws.com",
  ];

  for (const url of candidates) {
    const ip = await httpGetText(url);
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipRegex.test(ip)) {
      return ip;
    }
  }

  return "";
}

async function validateDns(domain, panelDomain, mxTarget) {
  const normalizedDomain = validateDomain(domain);
  const normalizedPanelDomain = validateDomain(panelDomain);
  const normalizedMxTarget = validateDomain(mxTarget || panelDomain);

  if (!normalizedDomain || !normalizedPanelDomain || !normalizedMxTarget) {
    return {
      success: false,
      error: "domain, panelDomain and mxTarget must be valid domains",
    };
  }

  const [aRecords, mxRecords, publicIp] = await Promise.all([
    dns.resolve4(normalizedPanelDomain).catch(() => []),
    dns.resolveMx(normalizedDomain).catch(() => []),
    getPublicIPv4(),
  ]);

  const mxHosts = mxRecords
    .map((mx) => String(mx.exchange || "").toLowerCase().replace(/\.$/, ""))
    .filter(Boolean);

  const panelResolves = aRecords.length > 0;
  const aMatchesServer = publicIp ? aRecords.includes(publicIp) : false;
  const mxHasTarget = mxHosts.includes(normalizedMxTarget);

  const steps = {
    panelARecordExists: panelResolves,
    panelARecordMatchesServer: aMatchesServer,
    rootDomainHasMxRecord: mxHosts.length > 0,
    mxPointsToExpectedHost: mxHasTarget,
  };

  const success = Object.values(steps).every(Boolean);

  return {
    success,
    domain: normalizedDomain,
    panelDomain: normalizedPanelDomain,
    mxTarget: normalizedMxTarget,
    publicIp,
    aRecords,
    mxHosts,
    steps,
  };
}

async function persistSetupState(state) {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(SETUP_PATH, state, { spaces: 2 });
  await fs.writeFile(
    SETUP_LOCK_PATH,
    JSON.stringify({ lockedAt: new Date().toISOString(), by: "first-setup" }, null, 2)
  );
  setupState = state;
}

app.get("/", (req, res) => {
  if (!isSetupComplete()) {
    return res.redirect("/setup");
  }

  if (!req.session?.isAdmin) {
    return res.redirect("/login");
  }

  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/setup", (_req, res) => {
  if (isSetupLocked()) {
    return res.redirect("/login");
  }

  return res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/login", (_req, res) => {
  if (!isSetupComplete()) {
    return res.redirect("/setup");
  }

  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/setup.js", (_req, res) => {
  if (isSetupLocked()) {
    return res.status(403).type("text/plain").send("Setup locked");
  }

  return res.sendFile(path.join(__dirname, "public", "setup.js"));
});

app.get("/login.js", (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "login.js"));
});

app.get("/ui.js", requireAuth, (_req, res) => {
  return res.sendFile(path.join(__dirname, "public", "ui.js"));
});

app.get("/api/system/status", (req, res) => {
  return res.json({
    setupComplete: isSetupComplete(),
    setupLocked: isSetupLocked(),
    loggedIn: Boolean(req.session?.isAdmin),
    domain: setupState?.domain || "",
    panelDomain: setupState?.panelDomain || "",
    mxTarget: setupState?.mxTarget || "",
  });
});

app.get("/api/health", (_req, res) => {
  return res.json({ ok: true, setupComplete: isSetupComplete(), setupLocked: isSetupLocked() });
});

app.post("/api/setup/validate-dns", async (req, res) => {
  if (isSetupLocked()) {
    return res.status(403).json({ error: "Setup already completed and locked" });
  }

  const domain = validateDomain(req.body?.domain);
  const panelDomain = validateDomain(req.body?.panelDomain);
  const mxTarget = validateDomain(req.body?.mxTarget || req.body?.panelDomain);

  if (!domain || !panelDomain || !mxTarget) {
    return res.status(400).json({ error: "Valid domain, panelDomain and mxTarget are required" });
  }

  try {
    const report = await validateDns(domain, panelDomain, mxTarget);
    return res.json(report);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "DNS validation failed" });
  }
});

app.post("/api/setup/complete", async (req, res) => {
  if (isSetupLocked()) {
    return res.status(403).json({ error: "Setup already completed and locked" });
  }

  const domain = validateDomain(req.body?.domain);
  const panelDomain = validateDomain(req.body?.panelDomain);
  const mxTarget = validateDomain(req.body?.mxTarget || req.body?.panelDomain);
  const adminUsername = String(req.body?.adminUsername || "").trim();
  const adminPassword = String(req.body?.adminPassword || "");
  const letsencryptEmail = String(req.body?.letsencryptEmail || "").trim().toLowerCase();

  if (!domain || !panelDomain || !mxTarget) {
    return res.status(400).json({ error: "Valid domain, panelDomain and mxTarget are required" });
  }

  if (adminUsername.length < 3) {
    return res.status(400).json({ error: "Admin username must be at least 3 chars" });
  }

  if (adminPassword.length < 8) {
    return res.status(400).json({ error: "Admin password must be at least 8 chars" });
  }

  const dnsReport = await validateDns(domain, panelDomain, mxTarget);
  if (!dnsReport.success) {
    return res.status(400).json({ error: "DNS checks failed", report: dnsReport });
  }

  const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
  const sessionSecret = crypto.randomBytes(32).toString("hex");

  const newState = {
    createdAt: new Date().toISOString(),
    domain,
    panelDomain,
    mxTarget,
    letsencryptEmail,
    maildirRoot: DEFAULT_MAILDIR_ROOT,
    adminUsername,
    adminPasswordHash,
    sessionSecret,
    setupLocked: true,
  };

  await persistSetupState(newState);

  req.session.isAdmin = true;

  return res.json({
    ok: true,
    message: "Setup completed and locked. You are logged in as admin.",
    next: {
      open: `https://${panelDomain}`,
      sslHint: "If SSL is not active yet, run scripts/install-vps.sh and follow SSL step.",
    },
  });
});

app.post("/api/auth/login", async (req, res) => {
  if (!isSetupComplete()) {
    return res.status(403).json({ error: "Setup is not complete" });
  }

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (username !== setupState.adminUsername) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, setupState.adminPasswordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  req.session.isAdmin = true;
  return res.json({ ok: true, username: setupState.adminUsername });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session?.isAdmin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return res.json({ ok: true, username: setupState?.adminUsername || "" });
});

app.get("/api/inbox/:email", requireSetup, requireAuth, async (req, res) => {
  try {
    const email = normalizeEmail(req.params.email);
    if (!email.includes("@")) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const messageFiles = pickMessageFiles();
    const results = [];

    for (const messageMeta of messageFiles) {
      const parsed = await readAndParseMessage(messageMeta);
      if (!messageHasRecipient(parsed, email)) {
        continue;
      }

      results.push(toSummary(messageMeta, parsed));
    }

    return res.json({
      inbox: email,
      count: results.length,
      items: results,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to read inbox" });
  }
});

app.get("/api/message/:id", requireSetup, requireAuth, async (req, res) => {
  try {
    const messageMeta = getMessageMetaById(req.params.id);
    if (!messageMeta) {
      return res.status(404).json({ error: "Message not found" });
    }

    const parsed = await readAndParseMessage(messageMeta);
    const attachments = (parsed.attachments || []).map((item, index) => ({
      index,
      filename: item.filename || `attachment-${index + 1}`,
      contentType: item.contentType || "application/octet-stream",
      size: item.size || (item.content ? item.content.length : 0),
      downloadUrl: `/api/message/${encodeURIComponent(messageMeta.id)}/attachment/${index}`,
    }));

    return res.json({
      id: messageMeta.id,
      from: parsed.from?.text || "",
      to: parsed.to?.text || "",
      cc: parsed.cc?.text || "",
      subject: parsed.subject || "(no subject)",
      date: parsed.date || null,
      html: htmlFromParsed(parsed),
      text: parsed.text || "",
      attachments,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to load message" });
  }
});

app.get("/api/message/:id/attachment/:index", requireSetup, requireAuth, async (req, res) => {
  try {
    const messageMeta = getMessageMetaById(req.params.id);
    if (!messageMeta) {
      return res.status(404).json({ error: "Message not found" });
    }

    const parsed = await readAndParseMessage(messageMeta);
    const index = Number(req.params.index);
    const attachment = parsed.attachments?.[index];

    if (!attachment) {
      return res.status(404).json({ error: "Attachment not found" });
    }

    const fileName = attachment.filename || `attachment-${index + 1}`;
    res.setHeader("Content-Type", attachment.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename=\"${fileName.replaceAll('"', "")}\"`);
    return res.send(attachment.content);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to load attachment" });
  }
});

app.listen(PORT, () => {
  console.log(`Mail panel running on port ${PORT}`);
  console.log(`MAILDIR_ROOT: ${getMaildirRoot()}`);
  console.log(`Setup complete: ${isSetupComplete()}`);
  console.log(`Setup locked: ${isSetupLocked()}`);
});
