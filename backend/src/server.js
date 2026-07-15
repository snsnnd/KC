import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDirectory = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);
const dataDirectory = process.env.DATA_DIR || path.join(backendDirectory, "data");
const uploadDirectory = process.env.UPLOAD_DIR || path.join(dataDirectory, "uploads");
const contentFile = path.join(dataDirectory, "content.json");
const applicationFile = path.join(dataDirectory, "applications.json");
const mailConfigFile = path.join(dataDirectory, "mail-config.enc.json");
const adminFile = path.join(dataDirectory, "admins.json");
const auditFile = path.join(dataDirectory, "audit.json");
const memberFile = path.join(dataDirectory, "members.json");
const resourceSecretFile = path.join(dataDirectory, "resource-secrets.enc.json");
const notificationFile = path.join(dataDirectory, "notifications.json");
const inventoryFile = path.join(dataDirectory, "inventory.json");
const inventoryLedgerFile = path.join(dataDirectory, "inventory-ledger.json");
const fundFile = path.join(dataDirectory, "funds.json");
const usageRequestFile = path.join(dataDirectory, "usage-requests.json");
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const secureCookies = process.env.COOKIE_SECURE === "true";

fs.mkdirSync(uploadDirectory, { recursive: true });
if (!fs.existsSync(contentFile)) fs.copyFileSync(path.join(backendDirectory, "config", "default-content.json"), contentFile);
if (!fs.existsSync(applicationFile)) fs.writeFileSync(applicationFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(auditFile)) fs.writeFileSync(auditFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(memberFile)) fs.writeFileSync(memberFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(notificationFile)) fs.writeFileSync(notificationFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(inventoryFile)) fs.writeFileSync(inventoryFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(inventoryLedgerFile)) fs.writeFileSync(inventoryLedgerFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(fundFile)) fs.writeFileSync(fundFile, "{\"accounts\":[],\"ledger\":[]}\n", { mode: 0o600 });
if (!fs.existsSync(usageRequestFile)) fs.writeFileSync(usageRequestFile, "[]\n", { mode: 0o600 });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "1mb" }));

const sessions = new Map();
const memberSessions = new Map();
const rateBuckets = new Map();
let writeQueue = Promise.resolve();
let resourceOperationQueue = Promise.resolve();
let auditEntries = readJson(auditFile);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeQueue = writeQueue.then(async () => {
    const temporaryFile = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryFile, file);
  });
  return writeQueue;
}

function withResourceLock(operation) {
  const run = resourceOperationQueue.then(operation);
  resourceOperationQueue = run.catch(() => {});
  return run;
}

function cleanString(value, maximum = 200) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanUrl(value) {
  const url = cleanString(value, 1000);
  if (!url) return "";
  if (url.startsWith("/uploads/")) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function cleanNumber(value, minimum = 0, maximum = 1_000_000_000) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum;
}

function normalizeContent(input) {
  const settings = input?.settings || {};
  const projects = Array.isArray(input?.projects) ? input.projects.slice(0, 30) : [];
  const departments = Array.isArray(input?.departments) ? input.departments.slice(0, 20) : [];
  const resources = Array.isArray(input?.resources) ? input.resources.slice(0, 50) : [];
  return {
    settings: {
      clubName: cleanString(settings.clubName, 60),
      englishName: cleanString(settings.englishName, 80),
      heroTitle: cleanString(settings.heroTitle, 80),
      heroDescription: cleanString(settings.heroDescription, 500),
      contactEmail: cleanString(settings.contactEmail, 120),
      managerEmail: cleanString(settings.managerEmail, 120)
    },
    projects: projects.map((project, index) => ({
      id: cleanString(project.id, 40) || `SYS_${String(index + 1).padStart(3, "0")}`,
      title: cleanString(project.title, 100),
      category: cleanString(project.category, 40) || cleanString(project.tags?.[0], 40) || "未分类",
      description: cleanString(project.description, 800),
      tags: (Array.isArray(project.tags) ? project.tags : []).slice(0, 10).map((tag) => cleanString(tag, 30)).filter(Boolean),
      color: /^#[0-9a-f]{6}$/i.test(project.color) ? project.color : "#b8ff3d",
      video: cleanUrl(project.video),
      poster: cleanUrl(project.poster),
      links: (Array.isArray(project.links) ? project.links : []).slice(0, 6).map((link) => ({ label: cleanString(link.label, 40), url: cleanUrl(link.url) }))
    })),
    departments: departments.map((department, index) => ({
      id: cleanString(department.id, 50) || `department-${index + 1}`,
      name: cleanString(department.name, 80),
      description: cleanString(department.description, 400),
      isOpen: department.isOpen !== false
    })),
    resources: resources.map((resource, index) => ({
      id: cleanString(resource.id, 60) || `resource-${index + 1}`,
      title: cleanString(resource.title, 120),
      description: cleanString(resource.description, 800),
      type: cleanString(resource.type, 40),
      url: cleanUrl(resource.url),
      accessNote: cleanString(resource.accessNote, 300),
      permissionKey: cleanString(resource.permissionKey, 80).toLowerCase().replace(/[^a-z0-9._-]/g, "")
    }))
  };
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key]) => key));
}

function sameOrigin(request) {
  const origin = request.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.get("host");
  } catch {
    return false;
  }
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function passwordHash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function createAdminRecord({ username, displayName, email, role = "editor", password }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: `ADM-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    username: cleanString(username, 40).toLowerCase(),
    displayName: cleanString(displayName, 60),
    email: cleanString(email, 120).toLowerCase(),
    role,
    salt,
    passwordHash: passwordHash(password, salt),
    createdAt: new Date().toISOString()
  };
}

function verifyAdminPassword(admin, password) {
  const expected = Buffer.from(admin.passwordHash, "hex");
  const supplied = Buffer.from(passwordHash(password, admin.salt), "hex");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function publicAdmin(admin) {
  return { id: admin.id, username: admin.username, displayName: admin.displayName, email: admin.email, role: admin.role, createdAt: admin.createdAt };
}

function createMemberRecord({ username, name, studentId, className, email, contact, departmentId, permissions = [], password }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: `MEM-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    username: cleanString(username, 40).toLowerCase(),
    name: cleanString(name, 60),
    studentId: cleanString(studentId, 30),
    className: cleanString(className, 60),
    email: cleanString(email, 120).toLowerCase(),
    contact: cleanString(contact, 80),
    departmentId: cleanString(departmentId, 50),
    permissions: [...new Set(permissions.map((item) => cleanString(item, 80).toLowerCase()).filter(Boolean))].slice(0, 100),
    status: "active",
    salt,
    passwordHash: passwordHash(password, salt),
    createdAt: new Date().toISOString()
  };
}

function publicMember(member) {
  return { id: member.id, username: member.username, name: member.name, studentId: member.studentId || "", className: member.className || "", email: member.email, contact: member.contact, departmentId: member.departmentId, permissions: member.permissions || [], status: member.status, createdAt: member.createdAt, updatedAt: member.updatedAt };
}

function verifyMemberPassword(member, password) {
  const expected = Buffer.from(member.passwordHash, "hex");
  const supplied = Buffer.from(passwordHash(password, member.salt), "hex");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

if (!fs.existsSync(adminFile)) {
  const managerEmail = readJson(contentFile).settings.managerEmail || process.env.MANAGER_EMAIL || "";
  const owner = createAdminRecord({ username: "admin", displayName: "主管理员", email: managerEmail, role: "owner", password: adminPassword });
  fs.writeFileSync(adminFile, `${JSON.stringify([owner], null, 2)}\n`, { mode: 0o600 });
}

function encryptMailConfig(config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", hash(sessionSecret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") };
}

function decryptMailConfig(payload) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", hash(sessionSecret), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8"));
}

let resourceSecrets = {};
if (fs.existsSync(resourceSecretFile)) {
  try {
    resourceSecrets = decryptMailConfig(readJson(resourceSecretFile));
  } catch (error) {
    console.error("Encrypted resource secrets could not be loaded", error.message);
  }
}

function rateLimited(key, limit, interval) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((time) => now - time < interval);
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return bucket.length > limit;
}

function requireAdmin(request, response, next) {
  const token = parseCookies(request).tech_admin;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return response.status(401).json({ error: "请重新登录" });
  }
  if (request.method !== "GET" && request.get("x-csrf-token") !== session.csrf) return response.status(403).json({ error: "安全令牌无效" });
  session.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  request.adminSession = session;
  request.adminUser = session.user;
  next();
}

function requireRole(...roles) {
  return (request, response, next) => roles.includes(request.adminUser.role) ? next() : response.status(403).json({ error: "当前账号没有执行此操作的权限" });
}

function requireMember(request, response, next) {
  const token = parseCookies(request).tech_member;
  const session = token && memberSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) memberSessions.delete(token);
    return response.status(401).json({ error: "请先登录成员中心" });
  }
  const member = readJson(memberFile).find((item) => item.id === session.member.id && item.status === "active");
  if (!member) return response.status(403).json({ error: "成员账号已停用" });
  session.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  session.member = publicMember(member);
  request.memberSession = session;
  request.member = session.member;
  next();
}

function canAccessResource(member, resource) {
  if (!resource.permissionKey) return true;
  return member.permissions.includes("*") || member.permissions.includes(resource.permissionKey);
}

function appendAudit(request, user, action, target, details = {}) {
  const entry = {
    id: `LOG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    timestamp: new Date().toISOString(),
    actor: user ? { id: user.id || "", username: user.username || "", displayName: user.displayName || user.username || "" } : null,
    action,
    target: cleanString(target, 120),
    details,
    source: crypto.createHash("sha256").update(`${request.ip}:${sessionSecret}`).digest("hex").slice(0, 12)
  };
  auditEntries.unshift(entry);
  auditEntries = auditEntries.slice(0, 5000);
  void writeJson(auditFile, auditEntries);
  return entry;
}

function noStore(response) {
  response.set("Cache-Control", "no-store");
}

function getPublicContent() {
  const content = readJson(contentFile);
  const { _meta, ...publicContent } = content;
  return {
    ...publicContent,
    resources: content.resources.map((resource) => resource.permissionKey ? { ...resource, url: "", protected: true } : { ...resource, protected: false })
  };
}

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "video/mp4", "video/webm"]);
const extensionByMime = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif", "video/mp4": ".mp4", "video/webm": ".webm" };
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_request, file, callback) => callback(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extensionByMime[file.mimetype] || ""}`)
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => callback(null, allowedMimeTypes.has(file.mimetype))
});

function createMailer(config) {
  if (!config?.email || !config?.authCode) return null;
  return nodemailer.createTransport({
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    auth: { user: config.email, pass: config.authCode },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true
  });
}

function mailFrom(content = readJson(contentFile)) {
  return { name: mailConfig?.senderName || `${content.settings.clubName || "科技创新社"}运营组`, address: mailConfig.email };
}

let mailConfig = null;
if (fs.existsSync(mailConfigFile)) {
  try {
    mailConfig = decryptMailConfig(readJson(mailConfigFile));
  } catch (error) {
    console.error("Encrypted mail configuration could not be loaded", error.message);
  }
} else if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailConfig = { email: process.env.SMTP_USER, authCode: process.env.SMTP_PASS };
}
let mailer = createMailer(mailConfig);

async function sendOperationalMail(subject, text, recipients) {
  const addresses = [...new Set((recipients || []).filter(Boolean).map((email) => String(email).toLowerCase()))];
  if (!mailer || !mailConfig || !addresses.length) return false;
  try {
    await mailer.sendMail({ from: mailFrom(), replyTo: mailConfig.replyTo || mailConfig.email, to: mailConfig.email, bcc: addresses.filter((email) => email !== mailConfig.email), subject, text });
    return true;
  } catch (error) {
    console.error("Operational email failed", error.message);
    return false;
  }
}

app.use((request, response, next) => {
  noStore(response);
  if (!sameOrigin(request)) return response.status(403).json({ error: "跨站请求已拒绝" });
  next();
});

app.get("/api/health", (_request, response) => response.json({ ok: true, mail: Boolean(mailer) }));
app.get("/api/content", (_request, response) => response.json(getPublicContent()));

app.post("/api/applications", async (request, response) => {
  const ipKey = `application:${request.ip}`;
  if (rateLimited(ipKey, 3, 10 * 60 * 1000)) return response.status(429).json({ error: "提交过于频繁，请稍后再试" });
  if (cleanString(request.body.website, 100)) return response.status(400).json({ error: "请求无效" });

  const content = readJson(contentFile);
  const department = content.departments.find((item) => item.id === cleanString(request.body.departmentId, 50) && item.isOpen);
  const application = {
    id: `APP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    name: cleanString(request.body.name, 40),
    studentId: cleanString(request.body.studentId, 30),
    className: cleanString(request.body.className, 60),
    contact: cleanString(request.body.contact, 80),
    email: cleanString(request.body.email, 120),
    departmentId: department?.id || "",
    departmentName: department?.name || "",
    motivation: cleanString(request.body.motivation, 1200),
    portfolio: cleanUrl(request.body.portfolio),
    status: "new",
    createdAt: new Date().toISOString(),
    source: crypto.createHash("sha256").update(`${request.ip}:${sessionSecret}`).digest("hex").slice(0, 16)
  };
  if (application.name.length < 2 || application.studentId.length < 4 || application.className.length < 2 || application.contact.length < 3 || !application.departmentId || application.motivation.length < 10) {
    return response.status(400).json({ error: "请完整填写姓名、学号、班级、联系方式、部门和申请理由" });
  }

  const applications = readJson(applicationFile);
  applications.unshift(application);
  await writeJson(applicationFile, applications.slice(0, 2000));

  let notified = false;
  const managerEmail = content.settings.managerEmail || process.env.MANAGER_EMAIL;
  const notificationRecipients = mailConfig?.recipients?.length ? mailConfig.recipients : [managerEmail].filter(Boolean);
  if (mailer && notificationRecipients.length) {
    try {
      await mailer.sendMail({
        from: mailConfig ? mailFrom(content) : (process.env.SMTP_FROM || process.env.SMTP_USER),
        replyTo: mailConfig?.replyTo || mailConfig?.email,
        to: notificationRecipients,
        subject: `[科技创新社] 新申请 ${application.id}`,
        text: `姓名：${application.name}\n学号：${application.studentId}\n班级：${application.className}\n部门：${application.departmentName}\n联系方式：${application.contact}\n邮箱：${application.email || "未填写"}\n\n申请理由：\n${application.motivation}\n`
      });
      notified = true;
    } catch (error) {
      console.error("Application email failed", error.message);
    }
  }
  response.status(201).json({ ok: true, id: application.id, notified });
});

app.post("/api/member/login", (request, response) => {
  const username = cleanString(request.body.username, 40).toLowerCase();
  if (rateLimited(`member-login:${request.ip}:${username}`, 6, 15 * 60 * 1000)) return response.status(429).json({ error: "尝试次数过多，请稍后再试" });
  const member = readJson(memberFile).find((item) => item.username === username);
  if (!member || member.status !== "active" || !verifyMemberPassword(member, request.body.password)) {
    appendAudit(request, { username }, "member.login_failed", username);
    return response.status(401).json({ error: "成员账号或密码错误" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const user = publicMember(member);
  memberSessions.set(token, { member: user, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  response.setHeader("Set-Cookie", `tech_member=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? "; Secure" : ""}`);
  appendAudit(request, { ...user, displayName: user.name }, "member.login", username);
  response.json({ ok: true, member: user });
});
app.get("/api/member/session", requireMember, (request, response) => response.json({ ok: true, member: request.member }));
app.post("/api/member/logout", requireMember, (request, response) => {
  const token = parseCookies(request).tech_member;
  appendAudit(request, { ...request.member, displayName: request.member.name }, "member.logout", request.member.username);
  memberSessions.delete(token);
  response.setHeader("Set-Cookie", "tech_member=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
  response.json({ ok: true });
});
app.get("/api/member/resources", requireMember, (request, response) => {
  const resources = readJson(contentFile).resources.map((resource) => ({
    id: resource.id,
    title: resource.title,
    description: resource.description,
    type: resource.type,
    permissionKey: resource.permissionKey,
    authorized: canAccessResource(request.member, resource)
  }));
  response.json(resources);
});
app.get("/api/member/resources/:id", requireMember, (request, response) => {
  const resource = readJson(contentFile).resources.find((item) => item.id === request.params.id);
  if (!resource) return response.status(404).json({ error: "资源不存在" });
  if (!canAccessResource(request.member, resource)) {
    appendAudit(request, { ...request.member, displayName: request.member.name }, "resource.denied", resource.id, { permissionKey: resource.permissionKey });
    return response.status(403).json({ error: "当前成员没有访问该资料的权限" });
  }
  appendAudit(request, { ...request.member, displayName: request.member.name }, "resource.access", resource.id, { permissionKey: resource.permissionKey || "public" });
  response.json({ ...resource, accessSecret: resourceSecrets[resource.id] || "" });
});
app.get("/api/member/resource-management", requireMember, (request, response) => {
  const inventory = readJson(inventoryFile).filter((item) => item.status === "active").map((item) => ({ id: item.id, name: item.name, sku: item.sku, category: item.category, unit: item.unit, available: item.quantity, location: item.location }));
  const funds = readJson(fundFile).accounts.filter((account) => account.status === "active").map((account) => ({ id: account.id, name: account.name, currency: account.currency }));
  const requests = readJson(usageRequestFile).filter((item) => item.memberId === request.member.id);
  response.json({ inventory, funds, requests });
});
app.post("/api/member/usage-requests", requireMember, async (request, response) => {
  const type = request.body.type;
  if (!["material", "fund"].includes(type)) return response.status(400).json({ error: "申请类型无效" });
  const requiredPermission = type === "material" ? "material.request" : "fund.request";
  if (!request.member.permissions.includes("*") && !request.member.permissions.includes(requiredPermission)) return response.status(403).json({ error: `缺少权限 ${requiredPermission}` });
  const purpose = cleanString(request.body.purpose, 1000);
  if (purpose.length < 5) return response.status(400).json({ error: "请填写具体使用目的" });
  let target = null;
  let amount = 0;
  if (type === "material") {
    target = readJson(inventoryFile).find((item) => item.id === request.body.targetId && item.status === "active");
    amount = cleanNumber(request.body.quantity, 0, 1_000_000);
    if (!target || amount <= 0) return response.status(400).json({ error: "请选择有效材料和数量" });
  } else {
    target = readJson(fundFile).accounts.find((item) => item.id === request.body.targetId && item.status === "active");
    amount = cleanNumber(request.body.amount, 0, 100_000_000);
    if (!target || amount <= 0) return response.status(400).json({ error: "请选择有效资金账户和金额" });
  }
  const usageRequest = {
    id: `REQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    type,
    memberId: request.member.id,
    memberName: request.member.name,
    memberEmail: request.member.email,
    targetId: target.id,
    targetName: target.name,
    quantity: type === "material" ? amount : undefined,
    unit: type === "material" ? target.unit : undefined,
    amount: type === "fund" ? amount : undefined,
    currency: type === "fund" ? target.currency : undefined,
    purpose,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  await withResourceLock(async () => {
    const requests = readJson(usageRequestFile);
    requests.unshift(usageRequest);
    await writeJson(usageRequestFile, requests.slice(0, 5000));
  });
  appendAudit(request, { ...request.member, displayName: request.member.name }, "usage.request", usageRequest.id, { type, targetId: target.id, amount });
  void sendOperationalMail(`[资源审批] ${request.member.name} 提交${type === "material" ? "材料" : "资金"}申请`, `申请编号：${usageRequest.id}\n申请人：${request.member.name}\n对象：${target.name}\n数量/金额：${amount}${type === "material" ? target.unit : ` ${target.currency}`}\n用途：${purpose}`, mailConfig?.recipients || []);
  response.status(201).json({ ok: true, request: usageRequest });
});
app.delete("/api/member/usage-requests/:id", requireMember, async (request, response) => {
  const result = await withResourceLock(async () => {
    const requests = readJson(usageRequestFile);
    const usageRequest = requests.find((item) => item.id === request.params.id && item.memberId === request.member.id);
    if (!usageRequest) return { status: 404, error: "申请不存在" };
    if (usageRequest.status !== "pending") return { status: 409, error: "只有待审批申请可以撤销" };
    usageRequest.status = "cancelled";
    usageRequest.updatedAt = new Date().toISOString();
    await writeJson(usageRequestFile, requests);
    return { usageRequest };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const usageRequest = result.usageRequest;
  appendAudit(request, { ...request.member, displayName: request.member.name }, "usage.cancel", usageRequest.id);
  response.json({ ok: true, request: usageRequest });
});

app.post("/api/admin/login", (request, response) => {
  const username = cleanString(request.body.username || "admin", 40).toLowerCase();
  if (rateLimited(`login:${request.ip}:${username}`, 5, 15 * 60 * 1000)) return response.status(429).json({ error: "尝试次数过多，请稍后再试" });
  const admin = readJson(adminFile).find((item) => item.username === username);
  if (!admin || !verifyAdminPassword(admin, request.body.password)) {
    appendAudit(request, { username }, "auth.login_failed", username);
    return response.status(401).json({ error: "账号或密码错误" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const user = publicAdmin(admin);
  const session = { csrf: crypto.randomBytes(24).toString("base64url"), expiresAt: Date.now() + 8 * 60 * 60 * 1000, user };
  sessions.set(token, session);
  response.setHeader("Set-Cookie", `tech_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? "; Secure" : ""}`);
  appendAudit(request, user, "auth.login", username);
  response.json({ ok: true, csrf: session.csrf, user });
});

app.get("/api/admin/session", requireAdmin, (request, response) => response.json({ ok: true, csrf: request.adminSession.csrf, user: request.adminUser }));
app.post("/api/admin/logout", requireAdmin, (request, response) => {
  const token = parseCookies(request).tech_admin;
  appendAudit(request, request.adminUser, "auth.logout", request.adminUser.username);
  sessions.delete(token);
  response.setHeader("Set-Cookie", "tech_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  response.json({ ok: true });
});
app.get("/api/admin/content", requireAdmin, (_request, response) => response.json(readJson(contentFile)));
app.get("/api/admin/resource-secrets", requireAdmin, requireRole("owner", "editor"), (_request, response) => response.json(resourceSecrets));
app.put("/api/admin/content", requireAdmin, requireRole("owner", "editor"), async (request, response) => {
  const current = readJson(contentFile);
  const currentRevision = Number(current._meta?.revision || 0);
  const submittedRevision = Number(request.body._meta?.revision || 0);
  if (submittedRevision !== currentRevision) return response.status(409).json({ error: "内容已被其他管理员更新，请同步后重试", latest: current._meta || { revision: currentRevision } });
  const content = normalizeContent(request.body);
  const submittedResources = Array.isArray(request.body.resources) ? request.body.resources : [];
  const nextSecrets = { ...resourceSecrets };
  content.resources.forEach((resource, index) => {
    const submitted = submittedResources[index] || {};
    if (submitted.clearSecret === true) delete nextSecrets[resource.id];
    else if (cleanString(submitted.accessSecret, 500)) nextSecrets[resource.id] = cleanString(submitted.accessSecret, 500);
  });
  const activeResourceIds = new Set(content.resources.map((resource) => resource.id));
  Object.keys(nextSecrets).forEach((id) => { if (!activeResourceIds.has(id)) delete nextSecrets[id]; });
  content._meta = { revision: currentRevision + 1, updatedAt: new Date().toISOString(), updatedBy: request.adminUser.displayName };
  await writeJson(contentFile, content);
  await writeJson(resourceSecretFile, encryptMailConfig(nextSecrets));
  resourceSecrets = nextSecrets;
  appendAudit(request, request.adminUser, "content.update", "site-content", { revision: content._meta.revision });
  response.json({ ok: true, content });
});
app.get("/api/admin/mail", requireAdmin, (_request, response) => response.json({
  configured: Boolean(mailer),
  email: mailConfig?.email || readJson(contentFile).settings.managerEmail || "",
  recipients: mailConfig?.recipients || [readJson(contentFile).settings.managerEmail].filter(Boolean),
  senderName: mailConfig?.senderName || `${readJson(contentFile).settings.clubName || "科技创新社"}运营组`,
  replyTo: mailConfig?.replyTo || mailConfig?.email || "",
  host: "smtp.qq.com",
  port: 465,
  secure: true
}));
app.put("/api/admin/mail", requireAdmin, requireRole("owner"), async (request, response) => {
  const email = cleanString(request.body.email, 120).toLowerCase();
  const authCode = cleanString(request.body.authCode, 200).replace(/\s+/g, "") || mailConfig?.authCode || "";
  const recipients = [...new Set((Array.isArray(request.body.recipients) ? request.body.recipients : []).map((item) => cleanString(item, 120).toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))].slice(0, 20);
  const senderName = cleanString(request.body.senderName, 80) || mailConfig?.senderName || `${readJson(contentFile).settings.clubName || "科技创新社"}运营组`;
  const replyTo = cleanString(request.body.replyTo, 120).toLowerCase() || mailConfig?.replyTo || email;
  if (!/^[^\s@]+@qq\.com$/i.test(email)) return response.status(400).json({ error: "请填写有效的 QQ 邮箱" });
  if (!authCode) return response.status(400).json({ error: "请填写 QQ SMTP 授权码" });
  if (!recipients.length) return response.status(400).json({ error: "请至少填写一个通知收件人" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return response.status(400).json({ error: "回复邮箱格式无效" });
  const candidate = { email, authCode, recipients, senderName, replyTo };
  const candidateMailer = createMailer(candidate);
  try {
    await candidateMailer.verify();
  } catch (error) {
    console.error("QQ SMTP verification failed", error.message);
    return response.status(400).json({ error: "QQ SMTP 验证失败，请检查邮箱和授权码" });
  }
  await writeJson(mailConfigFile, encryptMailConfig(candidate));
  mailConfig = candidate;
  mailer = candidateMailer;
  const content = readJson(contentFile);
  content.settings.managerEmail = email;
  content._meta = { revision: Number(content._meta?.revision || 0) + 1, updatedAt: new Date().toISOString(), updatedBy: request.adminUser.displayName };
  await writeJson(contentFile, content);
  appendAudit(request, request.adminUser, "mail.configure", email, { recipientCount: recipients.length });
  response.json({ ok: true, configured: true, email, recipients, senderName, replyTo, host: "smtp.qq.com", port: 465, secure: true });
});
app.post("/api/admin/mail/test", requireAdmin, requireRole("owner"), async (request, response) => {
  if (!mailer || !mailConfig) return response.status(400).json({ error: "请先配置 QQ SMTP 授权码" });
  try {
    const info = await mailer.sendMail({
      from: mailFrom(),
      replyTo: mailConfig.replyTo || mailConfig.email,
      to: mailConfig.recipients || [mailConfig.email],
      subject: "[科技创新社] 邮件通知测试成功",
      text: `这是一封来自科技创新社管理后台的测试邮件。\n\n发送时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n`
    });
    appendAudit(request, request.adminUser, "mail.test", mailConfig.email, { recipientCount: (mailConfig.recipients || [mailConfig.email]).length });
    response.json({ ok: true, messageId: info.messageId });
  } catch (error) {
    console.error("QQ SMTP test failed", error.message);
    response.status(502).json({ error: "测试邮件发送失败，请重新验证授权码" });
  }
});
app.get("/api/admin/notifications", requireAdmin, requireRole("owner", "editor"), (request, response) => {
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 100, 300));
  response.json(readJson(notificationFile).slice(0, limit));
});
app.post("/api/admin/notifications", requireAdmin, requireRole("owner", "editor"), async (request, response) => {
  if (!mailer || !mailConfig) return response.status(400).json({ error: "请先配置邮件通知通道" });
  const subject = cleanString(request.body.subject, 160);
  const message = cleanString(request.body.message, 10000);
  if (subject.length < 2 || message.length < 2) return response.status(400).json({ error: "请填写通知标题和正文" });
  const audience = request.body.audience || {};
  const members = readJson(memberFile).filter((member) => member.status === "active" && member.email);
  const memberIds = new Set(Array.isArray(audience.memberIds) ? audience.memberIds : []);
  const departmentIds = new Set(Array.isArray(audience.departmentIds) ? audience.departmentIds : []);
  const permissionKeys = new Set(Array.isArray(audience.permissionKeys) ? audience.permissionKeys : []);
  const emails = new Set();
  members.forEach((member) => {
    const selected = audience.allMembers === true || memberIds.has(member.id) || departmentIds.has(member.departmentId) || (member.permissions || []).some((permission) => permissionKeys.has(permission));
    if (selected) emails.add(member.email.toLowerCase());
  });
  if (audience.includeManagers === true) readJson(adminFile).forEach((admin) => { if (admin.email) emails.add(admin.email.toLowerCase()); });
  if (audience.includeDefaultRecipients === true) (mailConfig.recipients || []).forEach((email) => emails.add(email.toLowerCase()));
  (Array.isArray(audience.customEmails) ? audience.customEmails : []).map((email) => cleanString(email, 120).toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).forEach((email) => emails.add(email));
  const recipients = [...emails].slice(0, 500);
  if (!recipients.length) return response.status(400).json({ error: "所选对象中没有可用邮箱" });
  try {
    const info = await mailer.sendMail({
      from: mailFrom(),
      replyTo: mailConfig.replyTo || mailConfig.email,
      to: mailConfig.email,
      bcc: recipients.filter((email) => email !== mailConfig.email),
      subject,
      text: `${message}\n\n---\n此通知由 ${mailConfig.senderName || "社团运营组"} 发送。`
    });
    const record = {
      id: `NOTICE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      subject,
      message,
      recipients,
      recipientCount: recipients.length,
      audience: {
        allMembers: audience.allMembers === true,
        departmentIds: [...departmentIds],
        permissionKeys: [...permissionKeys],
        memberIds: [...memberIds],
        includeManagers: audience.includeManagers === true,
        includeDefaultRecipients: audience.includeDefaultRecipients === true
      },
      sentBy: request.adminUser,
      sentAt: new Date().toISOString(),
      messageId: info.messageId
    };
    const history = readJson(notificationFile);
    history.unshift(record);
    await writeJson(notificationFile, history.slice(0, 500));
    appendAudit(request, request.adminUser, "notification.send", record.id, { subject, recipientCount: recipients.length });
    response.status(201).json({ ok: true, notification: record });
  } catch (error) {
    console.error("Notification delivery failed", error.message);
    appendAudit(request, request.adminUser, "notification.failed", subject, { recipientCount: recipients.length });
    response.status(502).json({ error: "邮件通知发送失败，请检查 SMTP 通道" });
  }
});
app.get("/api/admin/managers", requireAdmin, requireRole("owner"), (_request, response) => response.json(readJson(adminFile).map(publicAdmin)));
app.post("/api/admin/managers", requireAdmin, requireRole("owner"), async (request, response) => {
  const username = cleanString(request.body.username, 40).toLowerCase();
  const password = String(request.body.password || "");
  const role = ["owner", "editor", "reviewer"].includes(request.body.role) ? request.body.role : "editor";
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return response.status(400).json({ error: "账号需为 3-40 位英文、数字、点、横线或下划线" });
  if (password.length < 8) return response.status(400).json({ error: "密码至少需要 8 位" });
  const admins = readJson(adminFile);
  if (admins.some((item) => item.username === username)) return response.status(409).json({ error: "该管理员账号已存在" });
  const admin = createAdminRecord({ username, displayName: request.body.displayName || username, email: request.body.email, role, password });
  admins.push(admin);
  await writeJson(adminFile, admins);
  appendAudit(request, request.adminUser, "manager.create", username, { role });
  response.status(201).json({ ok: true, manager: publicAdmin(admin) });
});
app.patch("/api/admin/managers/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const admins = readJson(adminFile);
  const admin = admins.find((item) => item.id === request.params.id);
  if (!admin) return response.status(404).json({ error: "管理员不存在" });
  const nextRole = ["owner", "editor", "reviewer"].includes(request.body.role) ? request.body.role : admin.role;
  if (admin.role === "owner" && nextRole !== "owner" && admins.filter((item) => item.role === "owner").length === 1) return response.status(400).json({ error: "系统至少需要一名主管理员" });
  admin.displayName = cleanString(request.body.displayName || admin.displayName, 60);
  admin.email = cleanString(request.body.email || admin.email, 120).toLowerCase();
  admin.role = nextRole;
  if (request.body.password) {
    if (String(request.body.password).length < 8) return response.status(400).json({ error: "密码至少需要 8 位" });
    admin.salt = crypto.randomBytes(16).toString("hex");
    admin.passwordHash = passwordHash(request.body.password, admin.salt);
  }
  admin.updatedAt = new Date().toISOString();
  await writeJson(adminFile, admins);
  appendAudit(request, request.adminUser, "manager.update", admin.username, { role: admin.role, passwordChanged: Boolean(request.body.password) });
  response.json({ ok: true, manager: publicAdmin(admin) });
});
app.delete("/api/admin/managers/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const admins = readJson(adminFile);
  const admin = admins.find((item) => item.id === request.params.id);
  if (!admin) return response.status(404).json({ error: "管理员不存在" });
  if (admin.id === request.adminUser.id) return response.status(400).json({ error: "不能删除当前登录账号" });
  if (admin.role === "owner" && admins.filter((item) => item.role === "owner").length === 1) return response.status(400).json({ error: "系统至少需要一名主管理员" });
  await writeJson(adminFile, admins.filter((item) => item.id !== admin.id));
  for (const [token, session] of sessions) if (session.user.id === admin.id) sessions.delete(token);
  appendAudit(request, request.adminUser, "manager.delete", admin.username);
  response.json({ ok: true });
});
app.get("/api/admin/members", requireAdmin, requireRole("owner", "editor", "reviewer"), (_request, response) => response.json(readJson(memberFile).map(publicMember)));
app.post("/api/admin/members", requireAdmin, requireRole("owner"), async (request, response) => {
  const username = cleanString(request.body.username, 40).toLowerCase();
  const password = String(request.body.password || "");
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) return response.status(400).json({ error: "成员账号需为 3-40 位英文、数字、点、横线或下划线" });
  if (password.length < 8) return response.status(400).json({ error: "成员密码至少需要 8 位" });
  const members = readJson(memberFile);
  if (members.some((item) => item.username === username)) return response.status(409).json({ error: "该成员账号已存在" });
  const member = createMemberRecord({ ...request.body, username, password, permissions: Array.isArray(request.body.permissions) ? request.body.permissions : [] });
  members.push(member);
  await writeJson(memberFile, members);
  appendAudit(request, request.adminUser, "member.create", username, { permissions: member.permissions });
  response.status(201).json({ ok: true, member: publicMember(member) });
});
app.patch("/api/admin/members/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const members = readJson(memberFile);
  const member = members.find((item) => item.id === request.params.id);
  if (!member) return response.status(404).json({ error: "成员不存在" });
  if (request.body.name !== undefined) member.name = cleanString(request.body.name, 60);
  if (request.body.studentId !== undefined) member.studentId = cleanString(request.body.studentId, 30);
  if (request.body.className !== undefined) member.className = cleanString(request.body.className, 60);
  if (request.body.email !== undefined) member.email = cleanString(request.body.email, 120).toLowerCase();
  if (request.body.contact !== undefined) member.contact = cleanString(request.body.contact, 80);
  if (request.body.departmentId !== undefined) member.departmentId = cleanString(request.body.departmentId, 50);
  if (Array.isArray(request.body.permissions)) member.permissions = [...new Set(request.body.permissions.map((item) => cleanString(item, 80).toLowerCase()).filter(Boolean))].slice(0, 100);
  if (["active", "suspended"].includes(request.body.status)) member.status = request.body.status;
  if (request.body.password) {
    if (String(request.body.password).length < 8) return response.status(400).json({ error: "成员密码至少需要 8 位" });
    member.salt = crypto.randomBytes(16).toString("hex");
    member.passwordHash = passwordHash(request.body.password, member.salt);
  }
  member.updatedAt = new Date().toISOString();
  await writeJson(memberFile, members);
  if (member.status !== "active") for (const [token, session] of memberSessions) if (session.member.id === member.id) memberSessions.delete(token);
  appendAudit(request, request.adminUser, "member.update", member.username, { permissions: member.permissions, status: member.status, passwordChanged: Boolean(request.body.password) });
  response.json({ ok: true, member: publicMember(member) });
});
app.delete("/api/admin/members/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const members = readJson(memberFile);
  const member = members.find((item) => item.id === request.params.id);
  if (!member) return response.status(404).json({ error: "成员不存在" });
  await writeJson(memberFile, members.filter((item) => item.id !== member.id));
  for (const [token, session] of memberSessions) if (session.member.id === member.id) memberSessions.delete(token);
  appendAudit(request, request.adminUser, "member.delete", member.username);
  response.json({ ok: true });
});
app.post("/api/admin/applications/:id/promote", requireAdmin, requireRole("owner"), async (request, response) => {
  const applications = readJson(applicationFile);
  const application = applications.find((item) => item.id === request.params.id);
  if (!application) return response.status(404).json({ error: "申请不存在" });
  const members = readJson(memberFile);
  const username = cleanString(request.body.username, 40).toLowerCase();
  const password = String(request.body.password || "");
  if (!/^[a-z0-9._-]{3,40}$/.test(username) || password.length < 8) return response.status(400).json({ error: "请提供有效账号和至少 8 位的初始密码" });
  if (members.some((item) => item.username === username)) return response.status(409).json({ error: "该成员账号已存在" });
  const member = createMemberRecord({ username, password, name: application.name, studentId: application.studentId, className: application.className, email: application.email, contact: application.contact, departmentId: application.departmentId, permissions: Array.isArray(request.body.permissions) ? request.body.permissions : [] });
  members.push(member);
  application.status = "accepted";
  application.memberId = member.id;
  application.updatedAt = new Date().toISOString();
  await writeJson(memberFile, members);
  await writeJson(applicationFile, applications);
  appendAudit(request, request.adminUser, "application.promote", application.id, { memberId: member.id, username });
  response.status(201).json({ ok: true, member: publicMember(member), application });
});
app.get("/api/admin/inventory", requireAdmin, requireRole("owner", "editor", "reviewer"), (_request, response) => response.json({ items: readJson(inventoryFile), ledger: readJson(inventoryLedgerFile).slice(0, 500) }));
app.post("/api/admin/inventory", requireAdmin, requireRole("owner", "editor"), async (request, response) => {
  const name = cleanString(request.body.name, 120);
  const unit = cleanString(request.body.unit, 30);
  if (!name || !unit) return response.status(400).json({ error: "请填写材料名称和单位" });
  const item = {
    id: `MAT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    name,
    sku: cleanString(request.body.sku, 60),
    category: cleanString(request.body.category, 60),
    unit,
    quantity: cleanNumber(request.body.quantity, 0, 1_000_000_000),
    unitCost: cleanNumber(request.body.unitCost, 0, 100_000_000),
    location: cleanString(request.body.location, 120),
    notes: cleanString(request.body.notes, 500),
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await withResourceLock(async () => {
    const inventory = readJson(inventoryFile);
    inventory.push(item);
    await writeJson(inventoryFile, inventory);
    if (item.quantity > 0) {
      const ledger = readJson(inventoryLedgerFile);
      ledger.unshift({ id: `MATLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, itemId: item.id, itemName: item.name, direction: "in", quantity: item.quantity, unit: item.unit, reason: "初始库存", actor: request.adminUser, createdAt: new Date().toISOString() });
      await writeJson(inventoryLedgerFile, ledger.slice(0, 10000));
    }
  });
  appendAudit(request, request.adminUser, "inventory.create", item.id, { quantity: item.quantity, unit: item.unit });
  response.status(201).json({ ok: true, item });
});
app.patch("/api/admin/inventory/:id", requireAdmin, requireRole("owner", "editor"), async (request, response) => {
  const item = await withResourceLock(async () => {
    const inventory = readJson(inventoryFile);
    const target = inventory.find((entry) => entry.id === request.params.id);
    if (!target) return null;
    ["name", "sku", "category", "unit", "location", "notes"].forEach((field) => { if (request.body[field] !== undefined) target[field] = cleanString(request.body[field], field === "notes" ? 500 : 120); });
    if (request.body.unitCost !== undefined) target.unitCost = cleanNumber(request.body.unitCost, 0, 100_000_000);
    if (["active", "archived"].includes(request.body.status)) target.status = request.body.status;
    target.updatedAt = new Date().toISOString();
    await writeJson(inventoryFile, inventory);
    return target;
  });
  if (!item) return response.status(404).json({ error: "材料不存在" });
  appendAudit(request, request.adminUser, "inventory.update", item.id, { status: item.status });
  response.json({ ok: true, item });
});
app.post("/api/admin/inventory/:id/restock", requireAdmin, requireRole("owner", "editor"), async (request, response) => {
  const quantity = cleanNumber(request.body.quantity, 0, 1_000_000_000);
  const reason = cleanString(request.body.reason, 300);
  if (quantity <= 0 || !reason) return response.status(400).json({ error: "请填写入库数量和原因" });
  const result = await withResourceLock(async () => {
    const inventory = readJson(inventoryFile);
    const item = inventory.find((entry) => entry.id === request.params.id);
    if (!item) return null;
    item.quantity += quantity;
    item.updatedAt = new Date().toISOString();
    await writeJson(inventoryFile, inventory);
    const ledger = readJson(inventoryLedgerFile);
    ledger.unshift({ id: `MATLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, itemId: item.id, itemName: item.name, direction: "in", quantity, unit: item.unit, reason, actor: request.adminUser, createdAt: new Date().toISOString() });
    await writeJson(inventoryLedgerFile, ledger.slice(0, 10000));
    return item;
  });
  if (!result) return response.status(404).json({ error: "材料不存在" });
  appendAudit(request, request.adminUser, "inventory.restock", result.id, { quantity, reason });
  response.json({ ok: true, item: result });
});
app.get("/api/admin/funds", requireAdmin, requireRole("owner", "editor", "reviewer"), (_request, response) => response.json(readJson(fundFile)));
app.post("/api/admin/funds", requireAdmin, requireRole("owner"), async (request, response) => {
  const name = cleanString(request.body.name, 120);
  if (!name) return response.status(400).json({ error: "请填写资金账户名称" });
  const account = { id: `FUND-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, name, currency: cleanString(request.body.currency || "CNY", 10).toUpperCase(), balance: cleanNumber(request.body.balance, 0, 1_000_000_000), notes: cleanString(request.body.notes, 500), status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await withResourceLock(async () => {
    const funds = readJson(fundFile);
    funds.accounts.push(account);
    if (account.balance > 0) funds.ledger.unshift({ id: `FUNDLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, accountId: account.id, accountName: account.name, direction: "in", amount: account.balance, currency: account.currency, reason: "初始余额", actor: request.adminUser, createdAt: new Date().toISOString() });
    await writeJson(fundFile, funds);
  });
  appendAudit(request, request.adminUser, "fund.create", account.id, { balance: account.balance, currency: account.currency });
  response.status(201).json({ ok: true, account });
});
app.post("/api/admin/funds/:id/topup", requireAdmin, requireRole("owner"), async (request, response) => {
  const amount = cleanNumber(request.body.amount, 0, 1_000_000_000);
  const reason = cleanString(request.body.reason, 300);
  if (amount <= 0 || !reason) return response.status(400).json({ error: "请填写入账金额和原因" });
  const account = await withResourceLock(async () => {
    const funds = readJson(fundFile);
    const target = funds.accounts.find((entry) => entry.id === request.params.id);
    if (!target) return null;
    target.balance += amount;
    target.updatedAt = new Date().toISOString();
    funds.ledger.unshift({ id: `FUNDLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, accountId: target.id, accountName: target.name, direction: "in", amount, currency: target.currency, reason, actor: request.adminUser, createdAt: new Date().toISOString() });
    funds.ledger = funds.ledger.slice(0, 10000);
    await writeJson(fundFile, funds);
    return target;
  });
  if (!account) return response.status(404).json({ error: "资金账户不存在" });
  appendAudit(request, request.adminUser, "fund.topup", account.id, { amount, reason });
  response.json({ ok: true, account });
});
app.get("/api/admin/usage-requests", requireAdmin, requireRole("owner", "editor", "reviewer"), (_request, response) => response.json(readJson(usageRequestFile)));
app.patch("/api/admin/usage-requests/:id", requireAdmin, requireRole("owner", "reviewer"), async (request, response) => {
  const decision = request.body.decision;
  const reviewNote = cleanString(request.body.reviewNote, 500);
  if (!['approved', 'rejected'].includes(decision)) return response.status(400).json({ error: "审批结果无效" });
  const result = await withResourceLock(async () => {
    const requests = readJson(usageRequestFile);
    const usageRequest = requests.find((entry) => entry.id === request.params.id);
    if (!usageRequest) return { status: 404, error: "申请不存在" };
    if (usageRequest.status !== "pending") return { status: 409, error: "该申请已处理，不能重复审批" };
    if (decision === "approved" && usageRequest.type === "material") {
      const inventory = readJson(inventoryFile);
      const item = inventory.find((entry) => entry.id === usageRequest.targetId && entry.status === "active");
      if (!item || item.quantity < usageRequest.quantity) return { status: 409, error: "当前库存不足，无法批准" };
      item.quantity -= usageRequest.quantity;
      item.updatedAt = new Date().toISOString();
      await writeJson(inventoryFile, inventory);
      const ledger = readJson(inventoryLedgerFile);
      ledger.unshift({ id: `MATLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, itemId: item.id, itemName: item.name, direction: "out", quantity: usageRequest.quantity, unit: item.unit, reason: usageRequest.purpose, requestId: usageRequest.id, memberId: usageRequest.memberId, actor: request.adminUser, createdAt: new Date().toISOString() });
      await writeJson(inventoryLedgerFile, ledger.slice(0, 10000));
    }
    if (decision === "approved" && usageRequest.type === "fund") {
      const funds = readJson(fundFile);
      const account = funds.accounts.find((entry) => entry.id === usageRequest.targetId && entry.status === "active");
      if (!account || account.balance < usageRequest.amount) return { status: 409, error: "当前资金余额不足，无法批准" };
      account.balance -= usageRequest.amount;
      account.updatedAt = new Date().toISOString();
      funds.ledger.unshift({ id: `FUNDLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, accountId: account.id, accountName: account.name, direction: "out", amount: usageRequest.amount, currency: account.currency, reason: usageRequest.purpose, requestId: usageRequest.id, memberId: usageRequest.memberId, actor: request.adminUser, createdAt: new Date().toISOString() });
      funds.ledger = funds.ledger.slice(0, 10000);
      await writeJson(fundFile, funds);
    }
    usageRequest.status = decision;
    usageRequest.reviewNote = reviewNote;
    usageRequest.reviewedBy = request.adminUser;
    usageRequest.reviewedAt = new Date().toISOString();
    usageRequest.updatedAt = usageRequest.reviewedAt;
    await writeJson(usageRequestFile, requests);
    return { usageRequest };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, request.adminUser, `usage.${decision}`, result.usageRequest.id, { type: result.usageRequest.type, targetId: result.usageRequest.targetId });
  void sendOperationalMail(`[资源审批结果] ${result.usageRequest.id} ${decision === "approved" ? "已批准" : "未批准"}`, `申请：${result.usageRequest.targetName}\n结果：${decision === "approved" ? "已批准" : "未批准"}\n审批意见：${reviewNote || "无"}`, [result.usageRequest.memberEmail]);
  response.json({ ok: true, request: result.usageRequest });
});
app.get("/api/admin/audit", requireAdmin, (request, response) => {
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 200, 500));
  response.json(auditEntries.slice(0, limit));
});
app.get("/api/admin/sync", requireAdmin, (_request, response) => {
  const content = readJson(contentFile);
  const applications = readJson(applicationFile);
  const members = readJson(memberFile);
  const notifications = readJson(notificationFile);
  const inventory = readJson(inventoryFile);
  const funds = readJson(fundFile);
  const usageRequests = readJson(usageRequestFile);
  const applicationUpdatedAt = applications.reduce((latest, item) => {
    const timestamp = item.updatedAt || item.createdAt || "";
    return timestamp > latest ? timestamp : latest;
  }, "");
  response.json({
    content: content._meta || { revision: 0, updatedAt: null, updatedBy: null },
    applications: { total: applications.length, new: applications.filter((item) => item.status === "new").length, updatedAt: applicationUpdatedAt || null },
    members: { total: members.length, active: members.filter((item) => item.status === "active").length, updatedAt: members.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null },
    notifications: { total: notifications.length, latestAt: notifications[0]?.sentAt || null },
    inventory: { total: inventory.length, updatedAt: inventory.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null },
    funds: { total: funds.accounts.length, updatedAt: funds.accounts.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null },
    usageRequests: { total: usageRequests.length, pending: usageRequests.filter((item) => item.status === "pending").length, updatedAt: usageRequests.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null },
    audit: { latestId: auditEntries[0]?.id || null, latestAt: auditEntries[0]?.timestamp || null }
  });
});
app.get("/api/admin/applications", requireAdmin, (_request, response) => response.json(readJson(applicationFile)));
app.patch("/api/admin/applications/:id", requireAdmin, requireRole("owner", "editor", "reviewer"), async (request, response) => {
  const statuses = new Set(["new", "reviewing", "accepted", "rejected"]);
  const status = cleanString(request.body.status, 20);
  if (!statuses.has(status)) return response.status(400).json({ error: "状态无效" });
  const applications = readJson(applicationFile);
  const application = applications.find((item) => item.id === request.params.id);
  if (!application) return response.status(404).json({ error: "申请不存在" });
  application.status = status;
  application.updatedAt = new Date().toISOString();
  await writeJson(applicationFile, applications);
  appendAudit(request, request.adminUser, "application.status", application.id, { status });
  response.json({ ok: true, application });
});
app.delete("/api/admin/applications/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const applications = readJson(applicationFile);
  const remaining = applications.filter((item) => item.id !== request.params.id);
  if (remaining.length === applications.length) return response.status(404).json({ error: "申请不存在" });
  await writeJson(applicationFile, remaining);
  appendAudit(request, request.adminUser, "application.delete", request.params.id);
  response.json({ ok: true });
});
app.post("/api/admin/upload", requireAdmin, requireRole("owner", "editor"), upload.single("file"), (request, response) => {
  if (!request.file) return response.status(400).json({ error: "请选择 JPG、PNG、WebP、AVIF、MP4 或 WebM 文件" });
  appendAudit(request, request.adminUser, "media.upload", request.file.filename, { bytes: request.file.size, mime: request.file.mimetype });
  response.status(201).json({ ok: true, url: `/uploads/${request.file.filename}` });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return response.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "文件不能超过 100MB" : "上传失败" });
  response.status(500).json({ error: "服务器暂时无法处理请求" });
});

app.listen(port, "127.0.0.1", () => console.log(`Tech Club CMS listening on 127.0.0.1:${port}`));
