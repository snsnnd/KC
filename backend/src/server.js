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
const emailApprovalTokenFile = path.join(dataDirectory, "email-approval-tokens.json");
const memberActivationCodeFile = path.join(dataDirectory, "member-activation-codes.json");
const memberMessageFile = path.join(dataDirectory, "member-messages.json");
const bugReportFile = path.join(dataDirectory, "bug-reports.json");
const adminPassword = process.env.ADMIN_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const secureCookies = process.env.COOKIE_SECURE === "true";
const publicBaseUrl = cleanString(process.env.PUBLIC_BASE_URL, 500).replace(/\/$/, "");
const emailApprovalTtlMs = Math.max(1, Math.min(Number(process.env.EMAIL_APPROVAL_TTL_HOURS) || 24, 72)) * 60 * 60 * 1000;
const memberActivationTtlMs = Math.max(1, Math.min(Number(process.env.MEMBER_ACTIVATION_TTL_HOURS) || 168, 720)) * 60 * 60 * 1000;
const adminPanelKeys = ["settings", "projects", "departments", "resources", "applications", "mail", "notifications", "uploads", "members", "audit", "inventory", "funds", "usage"];
const assignableAdminPanelKeySet = new Set(adminPanelKeys.filter((panel) => panel !== "mail"));

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
if (!fs.existsSync(emailApprovalTokenFile)) fs.writeFileSync(emailApprovalTokenFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(memberActivationCodeFile)) fs.writeFileSync(memberActivationCodeFile, "[]\n", { mode: 0o600 });
if (!fs.existsSync(memberMessageFile)) fs.writeFileSync(memberMessageFile, "[]\n", { mode: 0o600 });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "1mb" }));

const sessions = new Map();
const memberSessions = new Map();
const rateBuckets = new Map();
let writeQueue = Promise.resolve();
let resourceOperationQueue = Promise.resolve();
let auditEntries = readJson(auditFile).slice(0, 5000);

setInterval(() => {
  const now = Date.now();
  for (const [key, entries] of rateBuckets) { const keep = entries.filter((time) => now - time < 60 * 60 * 1000); if (keep.length) rateBuckets.set(key, keep); else rateBuckets.delete(key); }
  for (const [token, session] of sessions) { if (session.expiresAt < now) sessions.delete(token); }
  for (const [token, session] of memberSessions) { if (session.expiresAt < now) memberSessions.delete(token); }
}, 5 * 60 * 1000).unref();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`readJson failed for ${file}: ${error.message}`);
    const text = String(fs.readFileSync(file, "utf8"));
    if (!text || text === "null") return {};
    return [];
  }
}

function writeJson(file, value) {
  const run = writeQueue.catch(() => {}).then(async () => {
    const temporaryFile = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(temporaryFile, file);
  });
  run.catch((error) => { console.error(`writeJson failed for ${file}: ${error.message}`); queueError = error; });
  writeQueue = run;
  return run;
}

let queueError = null;

function withResourceLock(operation) {
  const run = resourceOperationQueue.then(operation);
  resourceOperationQueue = run.catch((error) => {
    console.error(`resourceOperationQueue error: ${error.message}`);
    queueError = error;
  });
  return run;
}

function cleanString(value, maximum = 200) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanEmail(value) {
  const email = cleanString(value, 120).toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) ? email : "";
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

function normalizeResourceNode(resource, fallbackId, depth = 0, context = { count: 0 }) {
  context.count += 1;
  const children = depth < 2 && Array.isArray(resource?.children) ? resource.children.slice(0, 20) : [];
  return {
    id: cleanString(resource?.id, 60) || fallbackId,
    title: cleanString(resource?.title, 120),
    description: cleanString(resource?.description, 800),
    type: cleanString(resource?.type, 40) || (children.length ? "COLLECTION" : "RESOURCE"),
    url: cleanUrl(resource?.url),
    links: (Array.isArray(resource?.links) ? resource.links : []).slice(0, 12).map((link) => ({ label: cleanString(link.label, 60) || "打开资源", url: cleanUrl(link.url) })).filter((link) => link.url),
    accessNote: cleanString(resource?.accessNote, 300),
    permissionKey: cleanString(resource?.permissionKey, 80).toLowerCase().replace(/[^a-z0-9._-]/g, ""),
    children: children.map((child, index) => normalizeResourceNode(child, `${fallbackId}-child-${index + 1}`, depth + 1, context)).filter(() => context.count <= 200)
  };
}

function validateResourceTree(resources) {
  const ids = new Set();
  let count = 0;
  let error = "";
  const visit = (nodes, depth = 0, path = "resource") => {
    if (error || !Array.isArray(nodes)) return;
    if ((depth === 0 && nodes.length > 50) || (depth > 0 && nodes.length > 20)) {
      error = depth === 0 ? "顶层资源不能超过 50 个" : "每个合集最多包含 20 个直接子资源";
      return;
    }
    if (depth > 2) {
      error = "资源合集最多支持三级结构";
      return;
    }
    nodes.forEach((resource, index) => {
      if (error) return;
      count += 1;
      if (count > 200) {
        error = "资源节点总数不能超过 200 个";
        return;
      }
      const fallbackId = `${path}-${index + 1}`;
      const id = cleanString(resource?.id, 60) || fallbackId;
      if (ids.has(id)) {
        error = `资源 ID 重复：${id}`;
        return;
      }
      ids.add(id);
      if (Array.isArray(resource?.links) && resource.links.length > 12) {
        error = `资源 ${id} 最多配置 12 个附加链接`;
        return;
      }
      visit(resource?.children, depth + 1, `${fallbackId}-child`);
    });
  };
  visit(resources);
  return error;
}

function flattenResourceNodes(resources) {
  return (Array.isArray(resources) ? resources : []).flatMap((resource) => [resource, ...flattenResourceNodes(resource.children)]);
}

function findResourceNode(resources, id, ancestors = []) {
  for (const resource of Array.isArray(resources) ? resources : []) {
    if (resource.id === id) return { resource, ancestors };
    const found = findResourceNode(resource.children, id, [...ancestors, resource]);
    if (found) return found;
  }
  return null;
}

function normalizeContent(input) {
  const settings = input?.settings || {};
  const projects = Array.isArray(input?.projects) ? input.projects.slice(0, 30) : [];
  const departments = Array.isArray(input?.departments) ? input.departments.slice(0, 20) : [];
  const resources = Array.isArray(input?.resources) ? input.resources.slice(0, 50) : [];
  const resourceContext = { count: 0 };
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
      accountPrefix: cleanString(department.accountPrefix, 5).toUpperCase().replace(/[^A-Z0-9]/g, ""),
      isOpen: department.isOpen !== false
    })),
    resources: resources.map((resource, index) => normalizeResourceNode(resource, `resource-${index + 1}`, 0, resourceContext)).filter(() => resourceContext.count <= 200)
  };
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key]) => key));
}

function sameOrigin(request, strict = false) {
  const origin = request.get("origin");
  if (!origin) return !strict || request.get("host")?.startsWith("127.0.0.1") || request.get("host")?.startsWith("localhost");
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

function normalizeAdminPanelPermissions(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => cleanString(value, 40)).filter((value) => assignableAdminPanelKeySet.has(value)))];
}

function normalizeAdminDepartmentIds(values) {
  const validIds = new Set(readJson(contentFile).departments.map((department) => department.id));
  return [...new Set((Array.isArray(values) ? values : []).map((value) => cleanString(value, 50)).filter((value) => validIds.has(value)))];
}

function departmentAccountPrefix(department) {
  const configured = cleanString(department?.accountPrefix, 5).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (configured) return configured;
  return ({ software: "S", hardware: "H", product: "P" })[department?.id] || cleanString(department?.id, 1).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function assignedMemberUsername(departmentId, studentId) {
  const department = readJson(contentFile).departments.find((item) => item.id === cleanString(departmentId, 50));
  const normalizedStudentId = cleanString(studentId, 30).toUpperCase();
  const prefix = departmentAccountPrefix(department);
  return department && prefix && /^[A-Z0-9]{4,30}$/.test(normalizedStudentId) ? `${prefix}${normalizedStudentId}`.slice(0, 40) : "";
}

function createAdminRecord({ username, displayName, email, role = "editor", panelPermissions = [], departmentIds = [], password, memberId = "" }) {
  const salt = crypto.randomBytes(16).toString("hex");
  const record = {
    id: `ADM-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    username: cleanString(username, 40),
    displayName: cleanString(displayName, 60),
    email: cleanEmail(email),
    memberId: cleanString(memberId, 80),
    role,
    status: "active",
    panelPermissions: normalizeAdminPanelPermissions(panelPermissions),
    departmentIds: normalizeAdminDepartmentIds(departmentIds),
    createdAt: new Date().toISOString()
  };
  if (!record.memberId) {
    record.salt = salt;
    record.passwordHash = passwordHash(password, salt);
  }
  return record;
}

function verifyAdminPassword(admin, password) {
  const credential = admin.memberId ? readJson(memberFile).find((member) => member.id === admin.memberId && member.status === "active") : admin;
  if (!credential?.passwordHash || !credential.salt) return false;
  const expected = Buffer.from(credential.passwordHash, "hex");
  const supplied = Buffer.from(passwordHash(password, credential.salt), "hex");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function effectiveAdmin(admin) {
  if (!admin?.memberId) return admin;
  const member = readJson(memberFile).find((item) => item.id === admin.memberId);
  if (!member) return { ...admin, status: "disabled" };
  return {
    ...admin,
    username: member.username,
    displayName: member.name,
    email: member.email,
    mustChangePassword: member.mustChangePassword === true,
    status: admin.status === "disabled" || member.status !== "active" ? "disabled" : "active"
  };
}

function isActiveAdmin(admin) {
  const effective = effectiveAdmin(admin);
  return effective?.status !== "disabled" && effective?.mustChangePassword !== true;
}

function publicAdmin(admin) {
  admin = effectiveAdmin(admin);
  const isOwner = admin.role === "owner";
  const panelPermissions = isOwner ? [...adminPanelKeys, "managers"] : normalizeAdminPanelPermissions(admin.panelPermissions);
  if (!panelPermissions.includes("notifications")) panelPermissions.push("notifications");
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    email: admin.email,
    memberId: admin.memberId || "",
    role: admin.role,
    status: admin.status === "disabled" ? "disabled" : "active",
    mustChangePassword: admin.mustChangePassword === true,
    panelPermissions,
    departmentIds: isOwner ? readJson(contentFile).departments.map((department) => department.id) : normalizeAdminDepartmentIds(admin.departmentIds),
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt
  };
}

function createMemberRecord({ username, name, studentId, className, email, contact, departmentId, permissions = [], password }) {
  const salt = crypto.randomBytes(16).toString("hex");
  const initialPassword = password || crypto.randomBytes(32).toString("base64url");
  return {
    id: `MEM-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    username: cleanString(username, 40),
    name: cleanString(name, 60),
    studentId: cleanString(studentId, 30),
    className: cleanString(className, 60),
    email: cleanEmail(email),
    contact: cleanString(contact, 80),
    departmentId: cleanString(departmentId, 50),
    permissions: [...new Set(permissions.map((item) => cleanString(item, 80).toLowerCase()).filter(Boolean))].slice(0, 100),
    status: "active",
    mustChangePassword: true,
    accountScheme: "department-student",
    salt,
    passwordHash: passwordHash(initialPassword, salt),
    createdAt: new Date().toISOString()
  };
}

function publicMember(member) {
  return { id: member.id, username: member.username, name: member.name, studentId: member.studentId || "", className: member.className || "", email: member.email, contact: member.contact, departmentId: member.departmentId, permissions: member.permissions || [], status: member.status, mustChangePassword: member.mustChangePassword === true, accountScheme: member.accountScheme || "legacy", createdAt: member.createdAt, updatedAt: member.updatedAt };
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

function consumeRateLimits(rules) {
  const now = Date.now();
  const buckets = rules.map((rule) => ({ ...rule, entries: (rateBuckets.get(rule.key) || []).filter((time) => now - time < rule.interval) }));
  buckets.forEach((bucket) => rateBuckets.set(bucket.key, bucket.entries));
  const blocked = buckets.find((bucket) => bucket.entries.length >= bucket.limit);
  if (blocked) return { allowed: false, retryAfter: Math.max(1, Math.ceil((blocked.interval - (now - blocked.entries[0])) / 1000)), scope: blocked.scope };
  buckets.forEach((bucket) => {
    bucket.entries.push(now);
    rateBuckets.set(bucket.key, bucket.entries);
  });
  return { allowed: true, reservations: buckets.map((bucket) => ({ key: bucket.key, timestamp: now })) };
}

function releaseRateLimits(reservations) {
  (reservations || []).forEach(({ key, timestamp }) => {
    const entries = [...(rateBuckets.get(key) || [])];
    const index = entries.indexOf(timestamp);
    if (index >= 0) entries.splice(index, 1);
    rateBuckets.set(key, entries);
  });
}

function requireAdmin(request, response, next) {
  if (request.method !== "GET" && !sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const token = parseCookies(request).tech_admin;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return response.status(401).json({ error: "请重新登录" });
  }
  const admin = readJson(adminFile).find((item) => item.id === session.user.id);
  if (!admin || !isActiveAdmin(admin)) {
    sessions.delete(token);
    return response.status(401).json({ error: "管理员账号已失效或停用" });
  }
  if (request.method !== "GET" && request.get("x-csrf-token") !== session.csrf) return response.status(403).json({ error: "安全令牌无效" });
  session.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  session.user = publicAdmin(admin);
  request.adminSession = session;
  request.adminUser = session.user;
  next();
}

function requireRole(...roles) {
  return (request, response, next) => roles.includes(request.adminUser.role) ? next() : response.status(403).json({ error: "当前账号没有执行此操作的权限" });
}

function hasAdminPanel(admin, panel) {
  return admin.role === "owner" || panel === "notifications" || admin.panelPermissions.includes(panel);
}

function requirePanel(...panels) {
  return (request, response, next) => panels.some((panel) => hasAdminPanel(request.adminUser, panel)) ? next() : response.status(403).json({ error: "当前账号没有执行此操作的权限" });
}

function canAccessDepartment(admin, departmentId) {
  return admin.role === "owner" || (departmentId && admin.departmentIds.includes(departmentId));
}

function filterByDepartment(admin, records) {
  return admin.role === "owner" ? records : records.filter((record) => canAccessDepartment(admin, record.departmentId));
}

function usageRequestDepartmentId(usageRequest) {
  if (usageRequest.departmentId) return usageRequest.departmentId;
  return readJson(memberFile).find((member) => member.id === usageRequest.memberId)?.departmentId || "";
}

function requireMember(request, response, next) {
  if (request.method !== "GET" && !sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const token = parseCookies(request).tech_member;
  const session = token && memberSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) memberSessions.delete(token);
    return response.status(401).json({ error: "请先登录成员中心" });
  }
  const member = readJson(memberFile).find((item) => item.id === session.member.id && item.status === "active");
  if (!member) return response.status(403).json({ error: "成员账号已停用" });
  if (request.method !== "GET" && request.get("x-csrf-token") !== session.csrf) return response.status(403).json({ error: "安全令牌无效" });
  session.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  session.member = publicMember(member);
  request.memberSession = session;
  request.member = session.member;
  if (member.mustChangePassword === true && !["/api/member/session", "/api/member/password", "/api/member/logout"].includes(request.path)) return response.status(403).json({ error: "账号尚未使用一次性激活码完成激活", mustChangePassword: true });
  next();
}

function canAccessResource(member, resource, ancestors = []) {
  if (member.permissions.includes("*")) return true;
  return [...ancestors, resource].every((node) => !node.permissionKey || member.permissions.includes(node.permissionKey));
}

function memberResourceSummary(member, resource, ancestors = []) {
  if (!canAccessResource(member, resource, ancestors)) return null;
  const permissionKeys = [...new Set([...ancestors, resource].map((node) => node.permissionKey).filter(Boolean))];
  return {
    id: resource.id,
    title: resource.title,
    description: resource.description,
    type: resource.type,
    permissionKey: resource.permissionKey,
    permissionKeys,
    accessNote: resource.accessNote,
    hasEndpoints: Boolean(resource.url || resource.links?.length || resourceSecrets[resource.id]),
    children: (resource.children || []).map((child) => memberResourceSummary(member, child, [...ancestors, resource])).filter(Boolean)
  };
}

function publicResourceNode(resource, ancestorProtected = false) {
  const protectedResource = ancestorProtected || Boolean(resource.permissionKey);
  return {
    ...resource,
    url: protectedResource ? "" : resource.url,
    links: (resource.links || []).map((link) => protectedResource ? { ...link, url: "" } : link),
    children: (resource.children || []).map((child) => publicResourceNode(child, protectedResource)),
    protected: protectedResource
  };
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
  return { entry, persisted: writeJson(auditFile, auditEntries) };
}

function noStore(response) {
  response.set("Cache-Control", "no-store");
}

function getPublicContent() {
  const content = readJson(contentFile);
  const { _meta, ...publicContent } = content;
  return {
    ...publicContent,
    resources: content.resources.map((resource) => publicResourceNode(resource))
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

const defaultUsageMailTemplates = {
  approvedSubject: "[申请已批准] {申请编号} {申请对象}",
  approvedBody: "{申请人}，你好：\n\n你的{申请类型}申请已批准。\n申请编号：{申请编号}\n申请对象：{申请对象}\n数量/金额：{数量金额}\n用途：{用途}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n",
  rejectedSubject: "[申请未批准] {申请编号} {申请对象}",
  rejectedBody: "{申请人}，你好：\n\n你的{申请类型}申请未批准。\n申请编号：{申请编号}\n申请对象：{申请对象}\n数量/金额：{数量金额}\n用途：{用途}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n"
};

const defaultApplicationMailTemplates = {
  acceptedSubject: "[加入申请已通过] {申请编号} {部门}",
  acceptedBody: "{申请人}，你好：\n\n你的加入申请已通过审核。\n申请编号：{申请编号}\n申请部门：{部门}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n\n后续账号开通信息将另行发送。\n",
  rejectedSubject: "[加入申请未通过] {申请编号} {部门}",
  rejectedBody: "{申请人}，你好：\n\n你的加入申请本次未通过审核。\n申请编号：{申请编号}\n申请部门：{部门}\n审批意见：{审批意见}\n审批人：{审批人}\n审批时间：{审批时间}\n"
};

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

function renderMailTemplate(template, values) {
  return template.replace(/\{([^{}]+)\}/g, (placeholder, key) => Object.hasOwn(values, key) ? String(values[key] ?? "") : placeholder);
}

async function sendUsageDecisionEmail(usageRequest, decision, reviewNote, adminUser) {
  const currentMember = readJson(memberFile).find((member) => member.id === usageRequest.memberId);
  const recipient = cleanEmail(currentMember?.email);
  if (!mailer || !mailConfig || !recipient) return false;
  const prefix = decision === "approved" ? "approved" : "rejected";
  const values = {
    申请人: usageRequest.memberName,
    申请编号: usageRequest.id,
    申请类型: usageRequest.type === "material" ? "材料" : "资金",
    申请对象: usageRequest.targetName,
    数量金额: usageRequestDisplayValue(usageRequest),
    用途: usageRequest.purpose,
    结果: decision === "approved" ? "已批准" : "未批准",
    审批意见: reviewNote || "无",
    审批人: adminUser.displayName,
    审批时间: usageRequest.reviewedAt
  };
  const subject = renderMailTemplate(mailConfig[`usage${prefix[0].toUpperCase()}${prefix.slice(1)}Subject`] || defaultUsageMailTemplates[`${prefix}Subject`], values);
  const text = renderMailTemplate(mailConfig[`usage${prefix[0].toUpperCase()}${prefix.slice(1)}Body`] || defaultUsageMailTemplates[`${prefix}Body`], values);
  try {
    await mailer.sendMail({ from: mailFrom(), replyTo: mailConfig.replyTo || mailConfig.email, to: recipient, subject, text });
    return true;
  } catch (error) {
    console.error("Usage decision email failed", error.message);
    return false;
  }
}

function canReviewApplication(admin, application) {
  if (!isActiveAdmin(admin)) return false;
  const user = publicAdmin(admin);
  return hasAdminPanel(user, "applications") && canAccessDepartment(user, application.departmentId);
}

function isApplicationApprover(admin, application) {
  return canReviewApplication(admin, application) && Boolean(publicAdmin(admin).email);
}

function resolveApplicationEmailApprovalToken(rawToken, tokenRecords = readJson(emailApprovalTokenFile), applications = readJson(applicationFile), admins = readJson(adminFile)) {
  const token = cleanString(rawToken, 200);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 404, error: "审批链接无效" };
  const tokenRecord = tokenRecords.find((record) => record.kind === "application" && record.tokenHash === emailApprovalTokenHash(token));
  if (!tokenRecord) return { status: 404, error: "审批链接无效" };
  if (tokenRecord.usedAt || tokenRecord.invalidatedAt) return { status: 410, error: "审批链接已使用或已失效" };
  const expiresAt = Date.parse(tokenRecord.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { status: 410, error: "审批链接已过期" };
  if (!["accepted", "rejected"].includes(tokenRecord.action)) return { status: 404, error: "审批链接无效" };
  const application = applications.find((item) => item.id === tokenRecord.requestId);
  if (!application || ["accepted", "rejected"].includes(application.status)) return { status: 410, error: "该申请已处理或删除" };
  const admin = admins.find((item) => item.id === tokenRecord.adminId);
  if (!admin || !isApplicationApprover(admin, application)) return { status: 403, error: "审批权限已撤销" };
  const adminUser = publicAdmin(admin);
  if (tokenRecord.adminVersion !== adminApprovalVersion(admin) || tokenRecord.adminEmail !== adminUser.email) return { status: 410, error: "审批账号信息已变更，请使用最新邮件" };
  return { tokenRecord, application, adminUser };
}

async function sendApplicationApprovalEmails(application) {
  if (!mailer || !mailConfig || !validEmailApprovalBaseUrl()) return false;
  const configuredIds = Array.isArray(mailConfig.applicationRecipientAdminIds) ? new Set(mailConfig.applicationRecipientAdminIds) : null;
  const seenEmails = new Set();
  const approvers = readJson(adminFile).filter((admin) => {
    if (configuredIds?.size ? !configuredIds.has(admin.id) : admin.role !== "owner") return false;
    if (!isApplicationApprover(admin, application)) return false;
    const email = publicAdmin(admin).email;
    if (seenEmails.has(email)) return false;
    seenEmails.add(email);
    return true;
  });
  if (!approvers.length) return false;
  const expiresAt = new Date(Date.now() + emailApprovalTtlMs).toISOString();
  const issued = approvers.map((admin) => ({ admin, adminUser: publicAdmin(admin), acceptToken: crypto.randomBytes(32).toString("base64url"), rejectToken: crypto.randomBytes(32).toString("base64url") }));
  const issuedForPendingApplication = await withResourceLock(async () => {
    const currentApplication = readJson(applicationFile).find((item) => item.id === application.id);
    if (!currentApplication || currentApplication.memberId || ["accepted", "rejected"].includes(currentApplication.status)) return false;
    const records = readJson(emailApprovalTokenFile);
    const invalidatedAt = new Date().toISOString();
    records.forEach((record) => {
      if (record.kind === "application" && record.requestId === application.id && !record.usedAt && !record.invalidatedAt) {
        record.invalidatedAt = invalidatedAt;
        record.invalidatedReason = "reissued";
      }
    });
    issued.forEach(({ admin, adminUser, acceptToken, rejectToken }) => {
      [["accepted", acceptToken], ["rejected", rejectToken]].forEach(([action, token]) => records.unshift({ id: `MAILAPP-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, kind: "application", tokenHash: emailApprovalTokenHash(token), requestId: application.id, adminId: admin.id, adminEmail: adminUser.email, adminVersion: adminApprovalVersion(admin), action, expiresAt, createdAt: new Date().toISOString() }));
    });
    await writeJson(emailApprovalTokenFile, records.slice(0, 10000));
    return true;
  });
  if (!issuedForPendingApplication) return false;
  const deliveries = await Promise.allSettled(issued.map(async ({ admin, adminUser, acceptToken, rejectToken }) => {
    const currentAdmin = readJson(adminFile).find((item) => item.id === admin.id);
    const currentApplication = readJson(applicationFile).find((item) => item.id === application.id);
    if (!currentApplication || currentApplication.memberId || ["accepted", "rejected"].includes(currentApplication.status)) throw new Error("Application was processed before approval email delivery");
    if (!currentAdmin || !isApplicationApprover(currentAdmin, currentApplication) || publicAdmin(currentAdmin).email !== adminUser.email || adminApprovalVersion(currentAdmin) !== adminApprovalVersion(admin)) throw new Error("Application approval recipient changed before delivery");
    const acceptUrl = `${publicBaseUrl}/email-approval.html#kind=application&token=${acceptToken}`;
    const rejectUrl = `${publicBaseUrl}/email-approval.html#kind=application&token=${rejectToken}`;
    const text = `审批人：${adminUser.displayName}\n申请编号：${application.id}\n申请人：${application.name}\n学号：${application.studentId}\n班级：${application.className}\n部门：${application.departmentName}\n联系方式：${application.contact}\n申请理由：${application.motivation}\n\n通过：${acceptUrl}\n拒绝：${rejectUrl}\n\n链接将在 ${expiresAt} 失效，点击后仍需确认。`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#171717"><p style="color:#666;font-size:12px">TECH SYNERGY LAB / RECRUITMENT APPROVAL</p><h1 style="font-size:26px">加入申请待审核</h1><table style="width:100%;border-collapse:collapse;margin:24px 0"><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">申请人</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(application.name)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">学号 / 班级</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(`${application.studentId} / ${application.className}`)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">部门</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(application.departmentName)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">联系方式</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(application.contact)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">申请理由</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(application.motivation)}</td></tr></table><p><a href="${acceptUrl}" style="display:inline-block;padding:14px 24px;margin-right:8px;background:#181818;color:#fff;text-decoration:none">通过申请</a><a href="${rejectUrl}" style="display:inline-block;padding:14px 24px;background:#eee;color:#181818;text-decoration:none">拒绝申请</a></p><p style="margin-top:24px;color:#777;font-size:12px">链接绑定审批人 ${escapeHtml(adminUser.displayName)}，仅可使用一次，有效期至 ${escapeHtml(expiresAt)}。</p></div>`;
    await mailer.sendMail({ from: mailFrom(), replyTo: mailConfig.replyTo || mailConfig.email, to: adminUser.email, subject: `[加入申请待审核] ${application.name} / ${application.departmentName}`, text, html });
  }));
  deliveries.forEach((delivery) => { if (delivery.status === "rejected") console.error("Application approval email failed", delivery.reason?.message || delivery.reason); });
  return deliveries.some((delivery) => delivery.status === "fulfilled");
}

async function sendApplicationDecisionEmail(application, decision, reviewNote, adminUser) {
  const currentApplication = readJson(applicationFile).find((item) => item.id === application.id);
  if (!currentApplication || currentApplication.reviewedAt !== application.reviewedAt || currentApplication.status !== decision) return false;
  const recipient = cleanEmail(application.email);
  if (!mailer || !mailConfig || !recipient) return false;
  const prefix = decision === "accepted" ? "accepted" : "rejected";
  const values = {
    申请人: application.name,
    申请编号: application.id,
    部门: application.departmentName,
    学号: application.studentId,
    班级: application.className,
    申请理由: application.motivation,
    结果: decision === "accepted" ? "已通过" : "未通过",
    审批意见: reviewNote || "无",
    审批人: adminUser.displayName,
    审批时间: application.reviewedAt
  };
  const subject = renderMailTemplate(mailConfig[`application${prefix[0].toUpperCase()}${prefix.slice(1)}Subject`] || defaultApplicationMailTemplates[`${prefix}Subject`], values);
  const text = renderMailTemplate(mailConfig[`application${prefix[0].toUpperCase()}${prefix.slice(1)}Body`] || defaultApplicationMailTemplates[`${prefix}Body`], values);
  try {
    await mailer.sendMail({ from: mailFrom(), replyTo: mailConfig.replyTo || mailConfig.email, to: recipient, subject, text });
    return true;
  } catch (error) {
    console.error("Application decision email failed", error.message);
    return false;
  }
}

async function sendMemberQuestionNotification(thread, latestMessage = thread.message, isFollowUp = false) {
  if (!mailer || !mailConfig) return false;
  const recipients = [...new Set(readJson(adminFile).filter((admin) => isActiveAdmin(admin) && canAccessDepartment(publicAdmin(admin), thread.departmentId)).map((admin) => cleanEmail(publicAdmin(admin).email)).filter(Boolean))];
  if (!recipients.length) return false;
  try {
    await mailer.sendMail({
      from: mailFrom(),
      replyTo: thread.memberEmail || mailConfig.replyTo || mailConfig.email,
      bcc: recipients,
      subject: `[成员问询${isFollowUp ? "有新回复" : ""}] ${thread.subject}`,
      text: `成员：${thread.memberName} / ${thread.memberUsername}\n问询编号：${thread.id}\n主题：${thread.subject}\n\n${latestMessage}\n\n请登录管理后台通知中心回复：${publicBaseUrl}/admin.html?workspace=operations#notifications`
    });
    return true;
  } catch (error) {
    console.error("Member question email failed", error.message);
    return false;
  }
}

async function sendMemberQuestionReplyEmail(thread, reply) {
  const recipient = cleanEmail(readJson(memberFile).find((member) => member.id === thread.memberId)?.email);
  if (!mailer || !mailConfig || !recipient) return false;
  try {
    await mailer.sendMail({
      from: mailFrom(),
      replyTo: mailConfig.replyTo || mailConfig.email,
      to: recipient,
      subject: `[管理员回复] ${thread.subject}`,
      text: `${thread.memberName}，你好：\n\n${reply.admin.displayName} 回复了你的问询：\n${reply.message}\n\n问询编号：${thread.id}\n原问题：${thread.message}\n\n你可以登录成员中心查看完整记录。`
    });
    return true;
  } catch (error) {
    console.error("Member question reply email failed", error.message);
    return false;
  }
}

async function processApplicationDecision({ applicationId, decision, reviewNote, adminUser, rawToken = "" }) {
  return withResourceLock(async () => {
    const applications = readJson(applicationFile);
    const records = readJson(emailApprovalTokenFile);
    let application;
    let effectiveAdmin = adminUser;
    let tokenRecord = null;
    let effectiveDecision = decision;
    if (rawToken) {
      const resolved = resolveApplicationEmailApprovalToken(rawToken, records, applications, readJson(adminFile));
      if (resolved.error) return resolved;
      application = resolved.application;
      effectiveAdmin = resolved.adminUser;
      tokenRecord = resolved.tokenRecord;
      effectiveDecision = tokenRecord.action;
    } else {
      application = applications.find((item) => item.id === applicationId);
      const currentAdmin = readJson(adminFile).find((admin) => admin.id === effectiveAdmin?.id);
      if (!application || !currentAdmin || !canReviewApplication(currentAdmin, application)) return { status: 404, error: "申请不存在或审批权限已撤销" };
      effectiveAdmin = publicAdmin(currentAdmin);
    }
    if (!["accepted", "rejected"].includes(effectiveDecision)) return { status: 400, error: "审批结果无效" };
    if (["accepted", "rejected"].includes(application.status)) {
      if (rawToken) return { status: 409, error: "该申请已处理，不能重复审批" };
      if (application.memberId) return { status: 409, error: "已转为成员的申请不能修改审批结果" };
      if (application.status === effectiveDecision) return { status: 409, error: "该申请已经是当前审批结果" };
    }
    const reviewedAt = new Date().toISOString();
    application.status = effectiveDecision;
    application.reviewNote = cleanString(reviewNote, 500);
    application.reviewedBy = effectiveAdmin;
    application.reviewedAt = reviewedAt;
    application.reviewedVia = rawToken ? "email" : "admin";
    application.updatedAt = reviewedAt;
    await writeJson(applicationFile, applications);
    records.forEach((record) => {
      if (record.kind !== "application" || record.requestId !== application.id || record.usedAt || record.invalidatedAt) return;
      if (tokenRecord && record.id === tokenRecord.id) {
        record.usedAt = reviewedAt;
        record.usedByAdminId = effectiveAdmin.id;
      } else {
        record.invalidatedAt = reviewedAt;
        record.invalidatedReason = "request-processed";
      }
    });
    await writeJson(emailApprovalTokenFile, records);
    return { application, adminUser: effectiveAdmin, decision: effectiveDecision, tokenId: tokenRecord?.id || null };
  });
}

function memberActivationCodeHash(code) {
  return crypto.createHmac("sha256", sessionSecret).update(`member-activation:${code}`).digest("hex");
}

function generateMemberActivationCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 10 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

async function issueMemberActivationCode(member) {
  const code = generateMemberActivationCode();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + memberActivationTtlMs).toISOString();
  const records = readJson(memberActivationCodeFile);
  records.forEach((record) => {
    if (record.memberId === member.id && !record.usedAt && !record.invalidatedAt) {
      record.invalidatedAt = now;
      record.invalidatedReason = "reissued";
    }
  });
  records.unshift({ id: `ACT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, memberId: member.id, codeHash: memberActivationCodeHash(code), expiresAt, createdAt: now });
  await writeJson(memberActivationCodeFile, records.filter((record) => !record.invalidatedAt || Date.now() - Date.parse(record.invalidatedAt) < 30 * 24 * 60 * 60 * 1000).slice(0, 10000));
  return { code, expiresAt };
}

async function sendMemberActivationEmail(member, activation) {
  const recipient = cleanEmail(member.email);
  if (!mailer || !mailConfig || !recipient) return false;
  try {
    await mailer.sendMail({
      from: mailFrom(),
      replyTo: mailConfig.replyTo || mailConfig.email,
      to: recipient,
      subject: `[成员账号激活] ${member.username}`,
      text: `${member.name}，你好：\n\n你的成员账号为：${member.username}\n一次性激活码：${activation.code}\n激活码有效期至：${activation.expiresAt}\n\n请前往账号激活页 ${publicBaseUrl}/activate.html，使用账号、激活码和你自己设置的新密码完成激活。激活码只能使用一次；激活成功后请返回成员登录页手动登录。`
    });
    return true;
  } catch (error) {
    console.error("Member activation email failed", error.message);
    return false;
  }
}

function emailApprovalTokenHash(token) {
  return crypto.createHmac("sha256", sessionSecret).update(token).digest("hex");
}

function isEmailApprover(admin, usageRequest) {
  admin = effectiveAdmin(admin);
  if (!admin?.email || admin.status === "disabled" || admin.mustChangePassword) return false;
  const user = publicAdmin(admin);
  return (user.role === "owner" || (user.role === "reviewer" && hasAdminPanel(user, "usage"))) && canAccessDepartment(user, usageRequestDepartmentId(usageRequest));
}

function adminApprovalVersion(admin) {
  const member = admin?.memberId ? readJson(memberFile).find((item) => item.id === admin.memberId) : null;
  return `${admin?.updatedAt || admin?.createdAt || ""}:${member?.updatedAt || member?.createdAt || ""}`;
}

function usageRequestDisplayValue(usageRequest) {
  if (!usageRequest?.id || !usageRequest.memberId || !usageRequest.memberName || !usageRequest.departmentId || !usageRequest.targetId || !usageRequest.targetName || cleanString(usageRequest.purpose, 1000).length < 5) return "";
  if (usageRequest.type === "material") {
    const quantity = Number(usageRequest.quantity);
    return Number.isFinite(quantity) && quantity > 0 && usageRequest.unit ? `${quantity} ${usageRequest.unit}` : "";
  }
  if (usageRequest.type === "fund") {
    const amount = Number(usageRequest.amount);
    return Number.isFinite(amount) && amount > 0 && usageRequest.currency ? `${amount.toFixed(2)} ${usageRequest.currency}` : "";
  }
  return "";
}

function validEmailApprovalBaseUrl() {
  try {
    const url = new URL(publicBaseUrl);
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  } catch {
    return false;
  }
}

async function invalidateAdminEmailApprovalTokens(adminId, reason, invalidatedAt = new Date().toISOString()) {
  const tokenRecords = readJson(emailApprovalTokenFile);
  let changed = false;
  tokenRecords.forEach((record) => {
    if (record.adminId === adminId && !record.usedAt && !record.invalidatedAt) {
      changed = true;
      record.invalidatedAt = invalidatedAt;
      record.invalidatedReason = reason;
    }
  });
  if (changed) await writeJson(emailApprovalTokenFile, tokenRecords);
}

function resolveEmailApprovalToken(rawToken, tokenRecords = readJson(emailApprovalTokenFile), usageRequests = readJson(usageRequestFile), admins = readJson(adminFile)) {
  const token = cleanString(rawToken, 200);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 404, error: "审批链接无效" };
  const tokenRecord = tokenRecords.find((record) => record.kind !== "application" && record.tokenHash === emailApprovalTokenHash(token));
  if (!tokenRecord) return { status: 404, error: "审批链接无效" };
  if (tokenRecord.usedAt || tokenRecord.invalidatedAt) return { status: 410, error: "审批链接已使用或已失效" };
  const expiresAt = Date.parse(tokenRecord.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { status: 410, error: "审批链接已过期" };
  const usageRequest = usageRequests.find((item) => item.id === tokenRecord.requestId);
  if (!usageRequest || usageRequest.status !== "pending") return { status: 410, error: "该申请已处理或撤销" };
  if (!usageRequestDisplayValue(usageRequest)) return { status: 410, error: "申请数据无效，不能通过邮件审批" };
  const admin = admins.find((item) => item.id === tokenRecord.adminId);
  if (!admin || !isEmailApprover(admin, usageRequest)) return { status: 403, error: "审批权限已撤销" };
  const adminUser = publicAdmin(admin);
  if ((tokenRecord.adminVersion && tokenRecord.adminVersion !== adminApprovalVersion(admin)) || (tokenRecord.adminEmail && tokenRecord.adminEmail !== adminUser.email)) return { status: 410, error: "审批账号信息已变更，请使用最新邮件" };
  if (!['approved', 'rejected'].includes(tokenRecord.action)) return { status: 404, error: "审批链接无效" };
  return { token, tokenRecord, usageRequest, admin, adminUser };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

async function sendUsageApprovalEmails(usageRequest) {
  const value = usageRequestDisplayValue(usageRequest);
  if (!mailer || !mailConfig || !validEmailApprovalBaseUrl() || !value) return false;
  const seenEmails = new Set();
  const approvers = readJson(adminFile).filter((admin) => {
    if (!isEmailApprover(admin, usageRequest)) return false;
    const email = publicAdmin(admin).email.toLowerCase();
    if (seenEmails.has(email)) return false;
    seenEmails.add(email);
    return true;
  });
  if (!approvers.length) return false;
  const expiresAt = new Date(Date.now() + emailApprovalTtlMs).toISOString();
  const issued = approvers.map((admin) => {
    const approveToken = crypto.randomBytes(32).toString("base64url");
    const rejectToken = crypto.randomBytes(32).toString("base64url");
    return { admin, adminUser: publicAdmin(admin), approveToken, rejectToken };
  });
  await withResourceLock(async () => {
    const existing = readJson(emailApprovalTokenFile);
    existing.forEach((record) => {
      if (record.requestId === usageRequest.id && !record.usedAt && !record.invalidatedAt) {
        record.invalidatedAt = new Date().toISOString();
        record.invalidatedReason = "reissued";
      }
    });
    issued.forEach(({ admin, adminUser, approveToken, rejectToken }) => {
      [["approved", approveToken], ["rejected", rejectToken]].forEach(([action, token]) => existing.unshift({ id: `MAILAPP-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, tokenHash: emailApprovalTokenHash(token), requestId: usageRequest.id, adminId: admin.id, adminEmail: adminUser.email, adminVersion: adminApprovalVersion(admin), action, expiresAt, createdAt: new Date().toISOString() }));
    });
    await writeJson(emailApprovalTokenFile, existing.filter((record) => !record.invalidatedAt || Date.now() - Date.parse(record.invalidatedAt) < 30 * 24 * 60 * 60 * 1000).slice(0, 10000));
  });
  const departmentName = readJson(contentFile).departments.find((department) => department.id === usageRequest.departmentId)?.name || usageRequest.departmentId || "未分配部门";
  const subject = `[待审批] ${usageRequest.memberName} 的${usageRequest.type === "material" ? "材料" : "资金"}申请 ${usageRequest.id}`;
  const deliveries = await Promise.allSettled(issued.map(async ({ admin, adminUser, approveToken, rejectToken }) => {
    const currentAdmin = readJson(adminFile).find((item) => item.id === admin.id);
    if (!currentAdmin || publicAdmin(currentAdmin).email !== adminUser.email || adminApprovalVersion(currentAdmin) !== adminApprovalVersion(admin) || !isEmailApprover(currentAdmin, usageRequest)) throw new Error("Approval recipient changed before delivery");
    const approveUrl = `${publicBaseUrl}/email-approval.html#token=${approveToken}`;
    const rejectUrl = `${publicBaseUrl}/email-approval.html#token=${rejectToken}`;
    const text = `审批人：${adminUser.displayName}\n申请编号：${usageRequest.id}\n申请人：${usageRequest.memberName}\n部门：${departmentName}\n对象：${usageRequest.targetName}\n数量/金额：${value}\n用途：${usageRequest.purpose}\n\n批准：${approveUrl}\n拒绝：${rejectUrl}\n\n链接将在 ${expiresAt} 失效，点击后仍需确认。`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#171717"><p style="color:#666;font-size:12px">TECH SYNERGY LAB / APPROVAL GATE</p><h1 style="font-size:26px">${escapeHtml(usageRequest.type === "material" ? "材料使用申请" : "资金使用申请")}</h1><table style="width:100%;border-collapse:collapse;margin:24px 0"><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">申请人</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(usageRequest.memberName)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">部门</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(departmentName)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">材料/账户</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(usageRequest.targetName)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">数量/金额</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(value)}</td></tr><tr><td style="padding:8px;border-bottom:1px solid #ddd;color:#666">用途</td><td style="padding:8px;border-bottom:1px solid #ddd">${escapeHtml(usageRequest.purpose)}</td></tr></table><p><a href="${approveUrl}" style="display:inline-block;padding:14px 24px;margin-right:8px;background:#181818;color:#fff;text-decoration:none">批准申请</a><a href="${rejectUrl}" style="display:inline-block;padding:14px 24px;background:#eee;color:#181818;text-decoration:none">拒绝申请</a></p><p style="margin-top:24px;color:#777;font-size:12px">链接绑定审批人 ${escapeHtml(adminUser.displayName)}，仅可使用一次，有效期至 ${escapeHtml(expiresAt)}。点击链接不会直接审批，仍需在确认页确认。</p></div>`;
    await mailer.sendMail({ from: mailFrom(), replyTo: mailConfig.replyTo || mailConfig.email, to: adminUser.email, subject, text, html });
  }));
  deliveries.forEach((delivery) => { if (delivery.status === "rejected") console.error("Approval email failed", delivery.reason?.message || delivery.reason); });
  return deliveries.some((delivery) => delivery.status === "fulfilled");
}

async function processUsageDecision({ requestId, decision, reviewNote, adminUser, rawEmailToken = "" }) {
  return withResourceLock(async () => {
    const requests = readJson(usageRequestFile);
    const tokenRecords = readJson(emailApprovalTokenFile);
    let usageRequest;
    let tokenRecord = null;
    let effectiveAdmin = adminUser;
    let effectiveDecision = decision;
    if (rawEmailToken) {
      const resolved = resolveEmailApprovalToken(rawEmailToken, tokenRecords, requests, readJson(adminFile));
      if (resolved.error) return resolved;
      tokenRecord = resolved.tokenRecord;
      usageRequest = resolved.usageRequest;
      effectiveAdmin = resolved.adminUser;
      effectiveDecision = tokenRecord.action;
    } else {
      usageRequest = requests.find((entry) => entry.id === requestId);
      const currentAdmin = readJson(adminFile).find((admin) => admin.id === effectiveAdmin?.id);
      if (!currentAdmin || !isActiveAdmin(currentAdmin)) return { status: 403, error: "审批账号已停用或失效" };
      const currentAdminUser = publicAdmin(currentAdmin);
      if (!(currentAdminUser.role === "owner" || currentAdminUser.role === "reviewer") || !hasAdminPanel(currentAdminUser, "usage")) return { status: 403, error: "审批权限已撤销" };
      effectiveAdmin = currentAdminUser;
      if (!usageRequest || !canAccessDepartment(effectiveAdmin, usageRequestDepartmentId(usageRequest))) return { status: 404, error: "申请不存在" };
    }
    if (!['approved', 'rejected'].includes(effectiveDecision)) return { status: 400, error: "审批结果无效" };
    if (usageRequest.status !== "pending") return { status: 409, error: "该申请已处理，不能重复审批" };
    if (!usageRequestDisplayValue(usageRequest)) return { status: 409, error: "申请数据无效，不能审批" };
    if (effectiveDecision === "approved" && usageRequest.type === "material") {
      const inventory = readJson(inventoryFile);
      const item = inventory.find((entry) => entry.id === usageRequest.targetId && entry.status === "active");
      if (!item || item.quantity < usageRequest.quantity) return { status: 409, error: "当前库存不足，无法批准" };
      item.quantity -= usageRequest.quantity;
      item.updatedAt = new Date().toISOString();
      await writeJson(inventoryFile, inventory);
      const ledger = readJson(inventoryLedgerFile);
      ledger.unshift({ id: `MATLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, itemId: item.id, itemName: item.name, direction: "out", quantity: usageRequest.quantity, unit: item.unit, reason: usageRequest.purpose, requestId: usageRequest.id, memberId: usageRequest.memberId, actor: effectiveAdmin, createdAt: new Date().toISOString() });
      await writeJson(inventoryLedgerFile, ledger.slice(0, 10000));
    }
    if (effectiveDecision === "approved" && usageRequest.type === "fund") {
      const funds = readJson(fundFile);
      const account = funds.accounts.find((entry) => entry.id === usageRequest.targetId && entry.status === "active");
      if (!account || account.balance < usageRequest.amount) return { status: 409, error: "当前资金余额不足，无法批准" };
      account.balance -= usageRequest.amount;
      account.updatedAt = new Date().toISOString();
      funds.ledger.unshift({ id: `FUNDLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, accountId: account.id, accountName: account.name, direction: "out", amount: usageRequest.amount, currency: account.currency, reason: usageRequest.purpose, requestId: usageRequest.id, memberId: usageRequest.memberId, actor: effectiveAdmin, createdAt: new Date().toISOString() });
      funds.ledger = funds.ledger.slice(0, 10000);
      await writeJson(fundFile, funds);
    }
    const reviewedAt = new Date().toISOString();
    usageRequest.status = effectiveDecision;
    usageRequest.reviewNote = cleanString(reviewNote, 500);
    usageRequest.reviewedBy = effectiveAdmin;
    usageRequest.reviewedAt = reviewedAt;
    usageRequest.reviewedVia = rawEmailToken ? "email" : "admin";
    usageRequest.updatedAt = reviewedAt;
    await writeJson(usageRequestFile, requests);
    let tokensChanged = false;
    tokenRecords.forEach((record) => {
      if (record.requestId !== usageRequest.id || record.usedAt || record.invalidatedAt) return;
      tokensChanged = true;
      if (tokenRecord && record.id === tokenRecord.id) {
        record.usedAt = reviewedAt;
        record.usedByAdminId = effectiveAdmin.id;
      } else {
        record.invalidatedAt = reviewedAt;
        record.invalidatedReason = "request-processed";
      }
    });
    if (tokensChanged) await writeJson(emailApprovalTokenFile, tokenRecords);
    return { usageRequest, adminUser: effectiveAdmin, tokenId: tokenRecord?.id || null, decision: effectiveDecision };
  });
}

app.use((request, response, next) => {
  noStore(response);
  if (!sameOrigin(request)) return response.status(403).json({ error: "跨站请求已拒绝" });
  next();
});
app.get("/api/health", (request, response) => {
  const rateLimit = consumeRateLimits([{ key: `health:${request.ip}`, limit: 120, interval: 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) { response.set("Retry-After", String(rateLimit.retryAfter)); return response.status(429).json({ error: "请求过于频繁" }); }
  response.json({ ok: true, mail: Boolean(mailer), writeHealthy: !queueError });
});
app.get("/api/content", (request, response) => {
  const rateLimit = consumeRateLimits([{ key: `content:${request.ip}`, limit: 60, interval: 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) { response.set("Retry-After", String(rateLimit.retryAfter)); return response.status(429).json({ error: "请求过于频繁" }); }
  response.json(getPublicContent());
});

app.post("/api/applications", async (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  if (cleanString(request.body.website, 100)) return response.status(400).json({ error: "请求无效" });

  const content = readJson(contentFile);
  const department = content.departments.find((item) => item.id === cleanString(request.body.departmentId, 50) && item.isOpen);
  const submittedEmail = cleanString(request.body.email, 120);
  const application = {
    id: `APP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    name: cleanString(request.body.name, 40),
    studentId: cleanString(request.body.studentId, 30),
    className: cleanString(request.body.className, 60),
    contact: cleanString(request.body.contact, 80),
    email: cleanEmail(submittedEmail),
    departmentId: department?.id || "",
    departmentName: department?.name || "",
    motivation: cleanString(request.body.motivation, 1200),
    portfolio: cleanUrl(request.body.portfolio),
    consentAt: request.body.consent === "accepted" ? new Date().toISOString() : "",
    status: "new",
    createdAt: new Date().toISOString(),
    source: crypto.createHash("sha256").update(`${request.ip}:${sessionSecret}`).digest("hex").slice(0, 16)
  };
  const validationErrors = [];
  if (application.name.length < 2) validationErrors.push("姓名至少填写 2 个字符");
  if (application.studentId.length < 4) validationErrors.push("学号至少填写 4 个字符");
  if (application.className.length < 2) validationErrors.push("班级至少填写 2 个字符");
  if (application.contact.length < 3) validationErrors.push("联系方式至少填写 3 个字符");
  if (submittedEmail && !application.email) validationErrors.push("邮箱格式无效");
  if (!application.departmentId) validationErrors.push("请选择当前开放的部门");
  if (application.motivation.length < 10) validationErrors.push("申请理由至少填写 10 个字符");
  if (!application.consentAt) validationErrors.push("请确认同意招新信息使用说明");
  if (validationErrors.length) {
    return response.status(400).json({ error: `请检查：${validationErrors.join("；")}`, validationErrors });
  }

  const applicantKey = crypto.createHash("sha256").update(`${application.studentId.toLowerCase()}|${application.contact.toLowerCase()}|${sessionSecret}`).digest("hex").slice(0, 24);
  const rateLimit = consumeRateLimits([
    { key: `application-v2:applicant:${applicantKey}`, limit: 3, interval: 30 * 60 * 1000, scope: "applicant" },
    { key: `application-v2:network:${request.ip}`, limit: 30, interval: 10 * 60 * 1000, scope: "network" }
  ]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: rateLimit.scope === "applicant" ? "该申请人短时间内提交次数较多，请稍后再试" : "当前网络提交较多，请稍后再试", retryAfter: rateLimit.retryAfter });
  }

  try {
    await withResourceLock(async () => {
      const applications = readJson(applicationFile);
      applications.unshift(application);
      await writeJson(applicationFile, applications.slice(0, 2000));
    });
  } catch (error) {
    releaseRateLimits(rateLimit.reservations);
    throw error;
  }

  const notified = await sendApplicationApprovalEmails(application);
  response.status(201).json({ ok: true, id: application.id, notified });
});

app.post("/api/member/login", (request, response) => {
  const username = cleanString(request.body.username, 40).toLowerCase();
  if (rateLimited(`member-login:${request.ip}:${username}`, 6, 15 * 60 * 1000)) return response.status(429).json({ error: "尝试次数过多，请稍后再试" });
  const member = readJson(memberFile).find((item) => item.username.toLowerCase() === username);
  if (member?.status === "active" && member.mustChangePassword === true) return response.status(403).json({ error: "账号尚未激活，请使用一次性激活码设置密码" });
  if (!member || member.status !== "active" || !verifyMemberPassword(member, request.body.password)) {
    appendAudit(request, { username }, "member.login_failed", username);
    return response.status(401).json({ error: "成员账号或密码错误" });
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const user = publicMember(member);
  const csrf = crypto.randomBytes(16).toString("hex");
  memberSessions.set(token, { member: user, csrf, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  response.setHeader("Set-Cookie", `tech_member=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? "; Secure" : ""}`);
  appendAudit(request, { ...user, displayName: user.name }, "member.login", username);
  response.json({ ok: true, member: user, csrf });
});
app.post("/api/member/activate", async (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const username = cleanString(request.body.username, 40).toLowerCase();
  const activationCode = cleanString(request.body.activationCode, 20).toUpperCase();
  const nextPassword = String(request.body.nextPassword || "");
  const rateLimit = consumeRateLimits([
    { key: `member-activation-account:${username}`, limit: 20, interval: 15 * 60 * 1000, scope: "account" },
    { key: `member-activation-network:${request.ip}`, limit: 50, interval: 15 * 60 * 1000, scope: "network" }
  ]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "激活尝试次数过多，请稍后再试" });
  }
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(activationCode)) return response.status(400).json({ error: "激活码格式无效" });
  if (nextPassword.length < 8) return response.status(400).json({ error: "新密码至少需要 8 位" });
  const result = await withResourceLock(async () => {
    const members = readJson(memberFile);
    const member = members.find((item) => item.username.toLowerCase() === username && item.status === "active");
    if (!member || member.mustChangePassword !== true) return { status: 400, error: "账号不存在、已激活或已停用" };
    const records = readJson(memberActivationCodeFile);
    const record = records.find((item) => item.memberId === member.id && item.codeHash === memberActivationCodeHash(activationCode));
    const expiresAt = Date.parse(record?.expiresAt);
    if (!record || record.usedAt || record.invalidatedAt || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { status: 400, error: "激活码无效或已过期" };
    member.salt = crypto.randomBytes(16).toString("hex");
    member.passwordHash = passwordHash(nextPassword, member.salt);
    member.mustChangePassword = false;
    member.updatedAt = new Date().toISOString();
    record.usedAt = member.updatedAt;
    records.forEach((item) => {
      if (item.memberId === member.id && item.id !== record.id && !item.usedAt && !item.invalidatedAt) {
        item.invalidatedAt = member.updatedAt;
        item.invalidatedReason = "member-activated";
      }
    });
    await writeJson(memberFile, members);
    await writeJson(memberActivationCodeFile, records);
    return { member, activationId: record.id };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, { ...publicMember(result.member), displayName: result.member.name }, "member.activate", result.member.username, { activationId: result.activationId });
  response.json({ ok: true, member: publicMember(result.member) });
});
app.get("/api/member/session", requireMember, (request, response) => response.json({ ok: true, member: request.member, csrf: request.memberSession.csrf }));
app.post("/api/member/logout", requireMember, (request, response) => {
  const token = parseCookies(request).tech_member;
  appendAudit(request, { ...request.member, displayName: request.member.name }, "member.logout", request.member.username);
  memberSessions.delete(token);
  response.setHeader("Set-Cookie", `tech_member=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? "; Secure" : ""}`);
  response.json({ ok: true });
});
app.post("/api/member/password", requireMember, async (request, response) => {
  const currentPassword = String(request.body.currentPassword || "");
  const nextPassword = String(request.body.nextPassword || "");
  if (nextPassword.length < 8) return response.status(400).json({ error: "新密码至少需要 8 位" });
  const result = await withResourceLock(async () => {
    const members = readJson(memberFile);
    const member = members.find((item) => item.id === request.member.id && item.status === "active");
    if (!member || !verifyMemberPassword(member, currentPassword)) return { status: 401, error: "当前密码错误" };
    if (member.mustChangePassword === true) return { status: 403, error: "请使用一次性激活码完成账号激活" };
    member.salt = crypto.randomBytes(16).toString("hex");
    member.passwordHash = passwordHash(nextPassword, member.salt);
    member.mustChangePassword = false;
    member.updatedAt = new Date().toISOString();
    await writeJson(memberFile, members);
    const linkedAdmins = readJson(adminFile).filter((admin) => admin.memberId === member.id);
    for (const admin of linkedAdmins) await invalidateAdminEmailApprovalTokens(admin.id, "linked-member-password-changed", member.updatedAt);
    return { member, linkedAdmins };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const currentToken = parseCookies(request).tech_member;
  for (const [token, session] of memberSessions) {
    if (session.member.id !== result.member.id) continue;
    if (token === currentToken) session.member = publicMember(result.member);
    else memberSessions.delete(token);
  }
  for (const [token, session] of sessions) if (result.linkedAdmins.some((admin) => admin.id === session.user.id)) sessions.delete(token);
  appendAudit(request, { ...publicMember(result.member), displayName: result.member.name }, "member.password", result.member.username);
  response.json({ ok: true, member: publicMember(result.member) });
});
app.get("/api/member/messages", requireMember, (request, response) => response.json(readJson(memberMessageFile).filter((thread) => thread.memberId === request.member.id)));
app.post("/api/member/messages", requireMember, async (request, response) => {
  const subject = cleanString(request.body.subject, 160);
  const message = cleanString(request.body.message, 5000);
  if (subject.length < 2 || message.length < 5) return response.status(400).json({ error: "请填写问询主题和至少 5 个字符的内容" });
  const rateLimit = consumeRateLimits([{ key: `member-message:${request.member.id}`, limit: 10, interval: 60 * 60 * 1000, scope: "member" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "一小时内提交问询较多，请稍后再试" });
  }
  const thread = {
    id: `MSG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    memberId: request.member.id,
    memberName: request.member.name,
    memberUsername: request.member.username,
    memberEmail: cleanEmail(request.member.email),
    departmentId: request.member.departmentId,
    subject,
    message,
    status: "open",
    replies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  try {
    await withResourceLock(async () => {
      const threads = readJson(memberMessageFile);
      threads.unshift(thread);
      await writeJson(memberMessageFile, threads.slice(0, 5000));
    });
  } catch (error) {
    releaseRateLimits(rateLimit.reservations);
    throw error;
  }
  const notified = await sendMemberQuestionNotification(thread);
  appendAudit(request, { ...request.member, displayName: request.member.name }, "member.message.create", thread.id, { departmentId: thread.departmentId, notified });
  response.status(201).json({ ok: true, notified, thread });
});
app.post("/api/member/messages/:id/replies", requireMember, async (request, response) => {
  const message = cleanString(request.body.message, 5000);
  if (message.length < 2) return response.status(400).json({ error: "请填写至少 2 个字符的回复" });
  const rateLimit = consumeRateLimits([{ key: `member-thread-reply:${request.member.id}:${request.params.id}`, limit: 20, interval: 60 * 60 * 1000, scope: "thread" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "该问询一小时内回复较多，请稍后再试" });
  }
  const result = await withResourceLock(async () => {
    const threads = readJson(memberMessageFile);
    const thread = threads.find((item) => item.id === request.params.id && item.memberId === request.member.id);
    if (!thread) return { status: 404, error: "问询不存在" };
    const reply = { id: `REPLY-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, message, sender: "member", member: { id: request.member.id, username: request.member.username, name: request.member.name }, createdAt: new Date().toISOString() };
    thread.replies.push(reply);
    thread.status = "open";
    thread.updatedAt = reply.createdAt;
    await writeJson(memberMessageFile, threads);
    return { thread, reply };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const notified = await sendMemberQuestionNotification(result.thread, result.reply.message, true);
  appendAudit(request, { ...request.member, displayName: request.member.name }, "member.message.reply", result.thread.id, { reopened: true, notified });
  response.json({ ok: true, notified, thread: result.thread });
});
app.get("/api/member/resources", requireMember, (request, response) => response.json(readJson(contentFile).resources.map((resource) => memberResourceSummary(request.member, resource)).filter(Boolean)));
app.get("/api/member/resources/:id", requireMember, (request, response) => {
  const found = findResourceNode(readJson(contentFile).resources, request.params.id);
  if (!found) return response.status(404).json({ error: "资源不存在" });
  if (!canAccessResource(request.member, found.resource, found.ancestors)) {
    appendAudit(request, { ...request.member, displayName: request.member.name }, "resource.denied", found.resource.id, { permissionKey: found.resource.permissionKey });
    return response.status(403).json({ error: "当前成员没有访问该资料的权限" });
  }
  const { children: _children, ...resource } = found.resource;
  appendAudit(request, { ...request.member, displayName: request.member.name }, "resource.access", resource.id, { permissionKey: resource.permissionKey || "public" });
  response.json({ ...resource, children: (found.resource.children || []).map((child) => memberResourceSummary(request.member, child, [...found.ancestors, found.resource])).filter(Boolean), accessSecret: resourceSecrets[resource.id] || "" });
});
app.get("/api/member/resource-management", requireMember, (request, response) => {
  const canRequestMaterial = request.member.permissions.includes("*") || request.member.permissions.includes("material.request");
  const canRequestFund = request.member.permissions.includes("*") || request.member.permissions.includes("fund.request");
  const inventory = canRequestMaterial ? readJson(inventoryFile).filter((item) => item.status === "active").map((item) => ({ id: item.id, name: item.name, sku: item.sku, category: item.category, unit: item.unit, available: item.quantity, location: item.location })) : [];
  const funds = canRequestFund ? readJson(fundFile).accounts.filter((account) => account.status === "active").map((account) => ({ id: account.id, name: account.name, currency: account.currency })) : [];
  const requests = readJson(usageRequestFile).filter((item) => item.memberId === request.member.id);
  response.json({ inventory, funds, requests, capabilities: { materialRequests: canRequestMaterial, fundRequests: canRequestFund, requestHistory: requests.length > 0 || canRequestMaterial || canRequestFund } });
});
app.post("/api/member/usage-requests", requireMember, async (request, response) => {
  const type = request.body.type;
  if (!["material", "fund"].includes(type)) return response.status(400).json({ error: "申请类型无效" });
  const requiredPermission = type === "material" ? "material.request" : "fund.request";
  if (!request.member.permissions.includes("*") && !request.member.permissions.includes(requiredPermission)) return response.status(403).json({ error: `缺少权限 ${requiredPermission}` });
  const purpose = cleanString(request.body.purpose, 1000);
  if (purpose.length < 5) return response.status(400).json({ error: "请填写具体使用目的" });
  const amount = type === "material" ? cleanNumber(request.body.quantity, 0, 1_000_000) : cleanNumber(request.body.amount, 0, 100_000_000);
  if (amount <= 0) return response.status(400).json({ error: type === "material" ? "请选择有效材料和数量" : "请选择有效资金账户和金额" });
  const result = await withResourceLock(async () => {
    const target = type === "material" ? readJson(inventoryFile).find((item) => item.id === request.body.targetId && item.status === "active") : readJson(fundFile).accounts.find((item) => item.id === request.body.targetId && item.status === "active");
    if (!target) return { status: 400, error: type === "material" ? "请选择有效材料和数量" : "请选择有效资金账户和金额" };
    const usageRequest = {
      id: `REQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      type,
      memberId: request.member.id,
      memberName: request.member.name,
      memberEmail: request.member.email,
      departmentId: request.member.departmentId,
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
    const requests = readJson(usageRequestFile);
    requests.unshift(usageRequest);
    await writeJson(usageRequestFile, requests.slice(0, 5000));
    return { usageRequest };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const usageRequest = result.usageRequest;
  appendAudit(request, { ...request.member, displayName: request.member.name }, "usage.request", usageRequest.id, { type, targetId: usageRequest.targetId, amount });
  void sendUsageApprovalEmails(usageRequest);
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
    const tokenRecords = readJson(emailApprovalTokenFile);
    let tokensChanged = false;
    tokenRecords.forEach((record) => {
      if (record.requestId === usageRequest.id && !record.usedAt && !record.invalidatedAt) {
        tokensChanged = true;
        record.invalidatedAt = usageRequest.updatedAt;
        record.invalidatedReason = "request-cancelled";
      }
    });
    if (tokensChanged) await writeJson(emailApprovalTokenFile, tokenRecords);
    return { usageRequest };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const usageRequest = result.usageRequest;
  appendAudit(request, { ...request.member, displayName: request.member.name }, "usage.cancel", usageRequest.id);
  response.json({ ok: true, request: usageRequest });
});

app.post("/api/email-approvals/preview", (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const rateLimit = consumeRateLimits([{ key: `email-approval-preview:${request.ip}`, limit: 60, interval: 10 * 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  const resolved = resolveEmailApprovalToken(request.body.token);
  if (resolved.error) return response.status(resolved.status).json({ error: resolved.error });
  const departmentName = readJson(contentFile).departments.find((department) => department.id === resolved.usageRequest.departmentId)?.name || resolved.usageRequest.departmentId || "未分配部门";
  const value = usageRequestDisplayValue(resolved.usageRequest);
  response.json({
    ok: true,
    approval: {
      requestId: resolved.usageRequest.id,
      type: resolved.usageRequest.type,
      applicantName: resolved.usageRequest.memberName,
      departmentName,
      targetName: resolved.usageRequest.targetName,
      value,
      purpose: resolved.usageRequest.purpose,
      action: resolved.tokenRecord.action,
      approverName: resolved.adminUser.displayName,
      expiresAt: resolved.tokenRecord.expiresAt
    }
  });
});

app.post("/api/email-approvals/confirm", async (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const rateLimit = consumeRateLimits([{ key: `email-approval-confirm:${request.ip}`, limit: 20, interval: 10 * 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "确认请求过于频繁，请稍后再试" });
  }
  const reviewNote = cleanString(request.body.reviewNote, 500);
  const result = await processUsageDecision({ rawEmailToken: request.body.token, reviewNote });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const audit = appendAudit(request, result.adminUser, `usage.email.${result.decision}`, result.usageRequest.id, { channel: "email", approvalMethod: "通过邮件审批", tokenId: result.tokenId, type: result.usageRequest.type, targetId: result.usageRequest.targetId });
  await audit.persisted;
  const notified = await sendUsageDecisionEmail(result.usageRequest, result.decision, reviewNote, result.adminUser);
  response.json({ ok: true, notified, request: { id: result.usageRequest.id, status: result.usageRequest.status, reviewedAt: result.usageRequest.reviewedAt, reviewedBy: result.adminUser.displayName, reviewedVia: "email" } });
});

app.post("/api/application-email-approvals/preview", (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const rateLimit = consumeRateLimits([{ key: `application-email-preview:${request.ip}`, limit: 60, interval: 10 * 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  const resolved = resolveApplicationEmailApprovalToken(request.body.token);
  if (resolved.error) return response.status(resolved.status).json({ error: resolved.error });
  response.json({
    ok: true,
    approval: {
      kind: "application",
      requestId: resolved.application.id,
      type: "application",
      applicantName: resolved.application.name,
      departmentName: resolved.application.departmentName,
      targetName: "加入科技创新社",
      value: `${resolved.application.studentId} / ${resolved.application.className}`,
      purpose: resolved.application.motivation,
      action: resolved.tokenRecord.action,
      approverName: resolved.adminUser.displayName,
      expiresAt: resolved.tokenRecord.expiresAt
    }
  });
});

app.post("/api/application-email-approvals/confirm", async (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const rateLimit = consumeRateLimits([{ key: `application-email-confirm:${request.ip}`, limit: 20, interval: 10 * 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "确认请求过于频繁，请稍后再试" });
  }
  const reviewNote = cleanString(request.body.reviewNote, 500);
  const result = await processApplicationDecision({ rawToken: request.body.token, reviewNote });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const audit = appendAudit(request, result.adminUser, `application.email.${result.decision}`, result.application.id, { channel: "email", approvalMethod: "通过邮件审批", tokenId: result.tokenId, departmentId: result.application.departmentId });
  await audit.persisted;
  const notified = await sendApplicationDecisionEmail(result.application, result.decision, reviewNote, result.adminUser);
  response.json({ ok: true, notified, request: { id: result.application.id, status: result.application.status, reviewedAt: result.application.reviewedAt, reviewedBy: result.adminUser.displayName, reviewedVia: "email" } });
});

app.post("/api/admin/login", (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const username = cleanString(request.body.username || "admin", 40).toLowerCase();
  if (rateLimited(`login:${request.ip}:${username}`, 5, 15 * 60 * 1000)) return response.status(429).json({ error: "尝试次数过多，请稍后再试" });
  const admin = readJson(adminFile).find((item) => effectiveAdmin(item).username.toLowerCase() === username);
  if (!admin) {
    const member = readJson(memberFile).find((item) => item.username.toLowerCase() === username && item.status === "active");
    if (member && verifyMemberPassword(member, request.body.password)) return response.status(403).json({ error: "该账号没有后台管理权限" });
  }
  if (!admin || effectiveAdmin(admin).status === "disabled" || !verifyAdminPassword(admin, request.body.password)) {
    appendAudit(request, { username }, "auth.login_failed", username);
    return response.status(401).json({ error: "账号或密码错误" });
  }
  if (effectiveAdmin(admin).mustChangePassword) return response.status(403).json({ error: "请先在成员中心使用一次性激活码完成账号激活" });
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
app.get("/api/admin/content", requireAdmin, (request, response) => {
  const content = readJson(contentFile);
  response.json({
    settings: content.settings,
    projects: hasAdminPanel(request.adminUser, "projects") ? content.projects : [],
    departments: request.adminUser.role === "owner" ? content.departments : content.departments.filter((department) => canAccessDepartment(request.adminUser, department.id)),
    resources: hasAdminPanel(request.adminUser, "resources") ? content.resources : [],
    _meta: content._meta || { revision: 0 }
  });
});
app.get("/api/admin/resource-secrets", requireAdmin, requirePanel("resources"), requireRole("owner", "editor"), (_request, response) => response.json(resourceSecrets));
app.put("/api/admin/content", requireAdmin, requirePanel("settings", "projects", "departments", "resources"), requireRole("owner", "editor"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const current = readJson(contentFile);
    const currentRevision = Number(current._meta?.revision || 0);
    const submittedRevision = Number(request.body._meta?.revision || 0);
    if (submittedRevision !== currentRevision) return { status: 409, error: "内容已被其他管理员更新，请同步后重试", latest: current._meta || { revision: currentRevision } };
    if (hasAdminPanel(request.adminUser, "resources")) {
      const resourceError = validateResourceTree(request.body.resources);
      if (resourceError) return { status: 400, error: resourceError };
    }
    const normalized = normalizeContent(request.body);
    const submittedDepartments = new Map(normalized.departments.map((department) => [department.id, department]));
    const content = {
      settings: hasAdminPanel(request.adminUser, "settings") ? normalized.settings : current.settings,
      projects: hasAdminPanel(request.adminUser, "projects") ? normalized.projects : current.projects,
      departments: request.adminUser.role === "owner" ? normalized.departments : hasAdminPanel(request.adminUser, "departments") ? current.departments.map((department) => canAccessDepartment(request.adminUser, department.id) && submittedDepartments.has(department.id) ? submittedDepartments.get(department.id) : department) : current.departments,
      resources: hasAdminPanel(request.adminUser, "resources") ? normalized.resources : current.resources
    };
    const submittedResources = Array.isArray(request.body.resources) ? request.body.resources : [];
    const nextSecrets = { ...resourceSecrets };
    const applySubmittedSecrets = (resources, submittedNodes) => resources.forEach((resource, index) => {
      const submitted = submittedNodes[index] || {};
      if (submitted.clearSecret === true) delete nextSecrets[resource.id];
      else if (cleanString(submitted.accessSecret, 500)) nextSecrets[resource.id] = cleanString(submitted.accessSecret, 500);
      applySubmittedSecrets(resource.children || [], Array.isArray(submitted.children) ? submitted.children : []);
    });
    if (hasAdminPanel(request.adminUser, "resources")) applySubmittedSecrets(content.resources, submittedResources);
    const activeResourceIds = new Set(flattenResourceNodes(content.resources).map((resource) => resource.id));
    Object.keys(nextSecrets).forEach((id) => { if (!activeResourceIds.has(id)) delete nextSecrets[id]; });
    content._meta = { revision: currentRevision + 1, updatedAt: new Date().toISOString(), updatedBy: request.adminUser.displayName };
    await writeJson(contentFile, content);
    await writeJson(resourceSecretFile, encryptMailConfig(nextSecrets));
    resourceSecrets = nextSecrets;
    return { content };
  });
  if (result.error) return response.status(result.status).json({ error: result.error, ...(result.latest ? { latest: result.latest } : {}) });
  appendAudit(request, request.adminUser, "content.update", "site-content", { revision: result.content._meta.revision });
  response.json({ ok: true, content: result.content });
});
app.get("/api/admin/mail", requireAdmin, requirePanel("mail"), (_request, response) => response.json({
  configured: Boolean(mailer),
  email: mailConfig?.email || readJson(contentFile).settings.managerEmail || "",
  recipients: mailConfig?.recipients || [readJson(contentFile).settings.managerEmail].filter(Boolean),
  senderName: mailConfig?.senderName || `${readJson(contentFile).settings.clubName || "科技创新社"}运营组`,
  replyTo: mailConfig?.replyTo || mailConfig?.email || "",
  usageApprovedSubject: mailConfig?.usageApprovedSubject || defaultUsageMailTemplates.approvedSubject,
  usageApprovedBody: mailConfig?.usageApprovedBody || defaultUsageMailTemplates.approvedBody,
  usageRejectedSubject: mailConfig?.usageRejectedSubject || defaultUsageMailTemplates.rejectedSubject,
  usageRejectedBody: mailConfig?.usageRejectedBody || defaultUsageMailTemplates.rejectedBody,
  applicationAcceptedSubject: mailConfig?.applicationAcceptedSubject || defaultApplicationMailTemplates.acceptedSubject,
  applicationAcceptedBody: mailConfig?.applicationAcceptedBody || defaultApplicationMailTemplates.acceptedBody,
  applicationRejectedSubject: mailConfig?.applicationRejectedSubject || defaultApplicationMailTemplates.rejectedSubject,
  applicationRejectedBody: mailConfig?.applicationRejectedBody || defaultApplicationMailTemplates.rejectedBody,
  applicationRecipientAdminIds: Array.isArray(mailConfig?.applicationRecipientAdminIds) ? mailConfig.applicationRecipientAdminIds : readJson(adminFile).map(publicAdmin).filter((admin) => admin.role === "owner" && admin.status === "active" && admin.email).map((admin) => admin.id),
  host: "smtp.qq.com",
  port: 465,
  secure: true
}));
app.put("/api/admin/mail", requireAdmin, requirePanel("mail"), requireRole("owner"), async (request, response) => {
  const email = cleanString(request.body.email, 120).toLowerCase();
  const authCode = cleanString(request.body.authCode, 200).replace(/\s+/g, "") || mailConfig?.authCode || "";
  const recipients = [...new Set((Array.isArray(request.body.recipients) ? request.body.recipients : []).map((item) => cleanString(item, 120).toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))].slice(0, 20);
  const senderName = cleanString(request.body.senderName, 80) || mailConfig?.senderName || `${readJson(contentFile).settings.clubName || "科技创新社"}运营组`;
  const replyTo = cleanString(request.body.replyTo, 120).toLowerCase() || mailConfig?.replyTo || email;
  const usageApprovedSubject = cleanString(request.body.usageApprovedSubject, 200) || mailConfig?.usageApprovedSubject || defaultUsageMailTemplates.approvedSubject;
  const usageApprovedBody = cleanString(request.body.usageApprovedBody, 5000) || mailConfig?.usageApprovedBody || defaultUsageMailTemplates.approvedBody;
  const usageRejectedSubject = cleanString(request.body.usageRejectedSubject, 200) || mailConfig?.usageRejectedSubject || defaultUsageMailTemplates.rejectedSubject;
  const usageRejectedBody = cleanString(request.body.usageRejectedBody, 5000) || mailConfig?.usageRejectedBody || defaultUsageMailTemplates.rejectedBody;
  const applicationAcceptedSubject = cleanString(request.body.applicationAcceptedSubject, 200) || mailConfig?.applicationAcceptedSubject || defaultApplicationMailTemplates.acceptedSubject;
  const applicationAcceptedBody = cleanString(request.body.applicationAcceptedBody, 5000) || mailConfig?.applicationAcceptedBody || defaultApplicationMailTemplates.acceptedBody;
  const applicationRejectedSubject = cleanString(request.body.applicationRejectedSubject, 200) || mailConfig?.applicationRejectedSubject || defaultApplicationMailTemplates.rejectedSubject;
  const applicationRejectedBody = cleanString(request.body.applicationRejectedBody, 5000) || mailConfig?.applicationRejectedBody || defaultApplicationMailTemplates.rejectedBody;
  const admins = readJson(adminFile).map(publicAdmin);
  const validApplicationAdminIds = new Set(admins.filter((admin) => admin.status === "active" && admin.email && hasAdminPanel(admin, "applications")).map((admin) => admin.id));
  const applicationRecipientAdminIds = [...new Set((Array.isArray(request.body.applicationRecipientAdminIds) ? request.body.applicationRecipientAdminIds : (mailConfig?.applicationRecipientAdminIds || [])).filter((id) => validApplicationAdminIds.has(id)))];
  if (!/^[^\s@]+@qq\.com$/i.test(email)) return response.status(400).json({ error: "请填写有效的 QQ 邮箱" });
  if (!authCode) return response.status(400).json({ error: "请填写 QQ SMTP 授权码" });
  if (!recipients.length) return response.status(400).json({ error: "请至少填写一个通知收件人" });
  if (!applicationRecipientAdminIds.length) return response.status(400).json({ error: "请至少选择一名申请通知负责人" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) return response.status(400).json({ error: "回复邮箱格式无效" });
  const candidate = { email, authCode, recipients, senderName, replyTo, applicationRecipientAdminIds, usageApprovedSubject, usageApprovedBody, usageRejectedSubject, usageRejectedBody, applicationAcceptedSubject, applicationAcceptedBody, applicationRejectedSubject, applicationRejectedBody };
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
  response.json({ ok: true, configured: true, email, recipients, senderName, replyTo, applicationRecipientAdminIds, usageApprovedSubject, usageApprovedBody, usageRejectedSubject, usageRejectedBody, applicationAcceptedSubject, applicationAcceptedBody, applicationRejectedSubject, applicationRejectedBody, host: "smtp.qq.com", port: 465, secure: true });
});
app.post("/api/admin/mail/test", requireAdmin, requirePanel("mail"), requireRole("owner"), async (request, response) => {
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
app.get("/api/admin/notifications", requireAdmin, requirePanel("notifications"), requireRole("owner", "editor", "reviewer"), (request, response) => {
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 100, 300));
  const notifications = readJson(notificationFile);
  response.json((request.adminUser.role === "owner" ? notifications : notifications.filter((item) => item.sentBy?.id === request.adminUser.id)).slice(0, limit));
});
app.get("/api/admin/notification-audience", requireAdmin, requirePanel("notifications"), requireRole("owner", "editor", "reviewer"), (request, response) => {
  const visibleMembers = filterByDepartment(request.adminUser, readJson(memberFile));
  const visibleApplications = filterByDepartment(request.adminUser, readJson(applicationFile));
  const members = visibleMembers.filter((member) => member.status === "active" && cleanEmail(member.email)).map((member) => ({ id: member.id, name: member.name, email: cleanEmail(member.email), departmentId: member.departmentId }));
  const applicants = visibleApplications.filter((application) => !application.memberId && cleanEmail(application.email)).map((application) => ({ id: application.id, name: application.name, email: cleanEmail(application.email), departmentId: application.departmentId, departmentName: application.departmentName, status: application.status }));
  const membersUpdatedAt = visibleMembers.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null;
  const applicationsUpdatedAt = visibleApplications.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null;
  response.json({ members, applicants, membersUpdatedAt, applicationsUpdatedAt });
});
app.get("/api/admin/member-messages", requireAdmin, requirePanel("notifications"), requireRole("owner", "editor", "reviewer"), (request, response) => {
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 200, 500));
  response.json(filterByDepartment(request.adminUser, readJson(memberMessageFile)).slice(0, limit));
});
app.post("/api/admin/member-messages/:id/replies", requireAdmin, requirePanel("notifications"), requireRole("owner", "editor", "reviewer"), async (request, response) => {
  const message = cleanString(request.body.message, 5000);
  if (message.length < 2) return response.status(400).json({ error: "请填写回复内容" });
  const rateLimit = consumeRateLimits([{ key: `member-message-reply:${request.adminUser.id}:${request.params.id}`, limit: 20, interval: 60 * 60 * 1000, scope: "thread" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "该问询一小时内回复较多，请稍后再试" });
  }
  const result = await withResourceLock(async () => {
    const currentAdmin = readJson(adminFile).find((admin) => admin.id === request.adminUser.id);
    const threads = readJson(memberMessageFile);
    const thread = threads.find((item) => item.id === request.params.id);
    if (!currentAdmin || !isActiveAdmin(currentAdmin) || !thread || !hasAdminPanel(publicAdmin(currentAdmin), "notifications") || !canAccessDepartment(publicAdmin(currentAdmin), thread.departmentId)) return { status: 404, error: "成员问询不存在或超出负责范围" };
    if (thread.status === "closed") return { status: 409, error: "该问询已结束，成员继续回复后会重新打开" };
    const adminUser = publicAdmin(currentAdmin);
    const reply = { id: `REPLY-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, message, sender: "admin", admin: { id: adminUser.id, username: adminUser.username, displayName: adminUser.displayName }, createdAt: new Date().toISOString() };
    thread.replies.push(reply);
    thread.status = request.body.close === true ? "closed" : "open";
    thread.updatedAt = reply.createdAt;
    await writeJson(memberMessageFile, threads);
    return { thread, reply, adminUser };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const notified = await sendMemberQuestionReplyEmail(result.thread, result.reply);
  appendAudit(request, result.adminUser, "member.message.reply", result.thread.id, { departmentId: result.thread.departmentId, closed: result.thread.status === "closed", notified });
  response.json({ ok: true, notified, thread: result.thread });
});
app.post("/api/admin/notifications", requireAdmin, requirePanel("notifications"), requireRole("owner", "editor", "reviewer"), async (request, response) => {
  if (!mailer || !mailConfig) return response.status(400).json({ error: "请先配置邮件通知通道" });
  const subject = cleanString(request.body.subject, 160);
  const message = cleanString(request.body.message, 10000);
  if (subject.length < 2 || message.length < 2) return response.status(400).json({ error: "请填写通知标题和正文" });
  const audience = request.body.audience || {};
  const members = filterByDepartment(request.adminUser, readJson(memberFile)).filter((member) => member.status === "active" && member.email);
  const applicants = filterByDepartment(request.adminUser, readJson(applicationFile)).filter((application) => !application.memberId && cleanEmail(application.email));
  const memberIds = new Set(Array.isArray(audience.memberIds) ? audience.memberIds : []);
  const applicationIds = new Set(Array.isArray(audience.applicationIds) ? audience.applicationIds : []);
  const departmentIds = new Set(Array.isArray(audience.departmentIds) ? audience.departmentIds : []);
  const permissionKeys = new Set(Array.isArray(audience.permissionKeys) ? audience.permissionKeys : []);
  if (request.adminUser.role !== "owner") {
    if ([...departmentIds].some((departmentId) => !canAccessDepartment(request.adminUser, departmentId)) || [...memberIds].some((memberId) => !members.some((member) => member.id === memberId)) || [...applicationIds].some((applicationId) => !applicants.some((application) => application.id === applicationId))) return response.status(400).json({ error: "通知对象超出负责部门范围" });
    if (audience.includeManagers === true || audience.includeDefaultRecipients === true || (Array.isArray(audience.customEmails) && audience.customEmails.length)) return response.status(403).json({ error: "只有主管理员可以向外部或管理组发送通知" });
  }
  const emails = new Set();
  members.forEach((member) => {
    const selected = audience.allMembers === true || memberIds.has(member.id) || departmentIds.has(member.departmentId) || (member.permissions || []).some((permission) => permissionKeys.has(permission));
    if (selected) emails.add(member.email.toLowerCase());
  });
  applicants.forEach((application) => {
    if (audience.allApplicants === true || applicationIds.has(application.id) || departmentIds.has(application.departmentId)) emails.add(cleanEmail(application.email));
  });
  if (audience.includeManagers === true) readJson(adminFile).map(publicAdmin).forEach((admin) => { if (admin.status === "active" && admin.email) emails.add(admin.email.toLowerCase()); });
  if (audience.includeDefaultRecipients === true) (mailConfig.recipients || []).forEach((email) => emails.add(email.toLowerCase()));
  (Array.isArray(audience.customEmails) ? audience.customEmails : []).map((email) => cleanString(email, 120).toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).forEach((email) => emails.add(email));
  const recipients = [...emails];
  if (!recipients.length) return response.status(400).json({ error: "所选对象中没有可用邮箱" });
  if (recipients.length > 500) return response.status(400).json({ error: `通知对象共 ${recipients.length} 个邮箱，单次最多发送 500 个，请缩小范围` });
  const rateLimit = consumeRateLimits([{ key: `admin-notification:${request.adminUser.id}`, limit: 10, interval: 10 * 60 * 1000, scope: "admin" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "十分钟内发送通知较多，请稍后再试" });
  }
  try {
    const info = await mailer.sendMail({
      from: mailFrom(),
      replyTo: mailConfig.replyTo || mailConfig.email,
      bcc: recipients,
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
        allApplicants: audience.allApplicants === true,
        applicationIds: [...applicationIds],
        includeManagers: audience.includeManagers === true,
        includeDefaultRecipients: audience.includeDefaultRecipients === true
      },
      sentBy: request.adminUser,
      sentAt: new Date().toISOString(),
      messageId: info.messageId
    };
    await withResourceLock(async () => {
      const history = readJson(notificationFile);
      history.unshift(record);
      await writeJson(notificationFile, history.slice(0, 500));
    });
    const recipientDigest = crypto.createHash("sha256").update([...recipients].sort().join("\n")).digest("hex").slice(0, 16);
    appendAudit(request, request.adminUser, "notification.send", record.id, { subject, recipientCount: recipients.length, recipientDigest, allMembers: audience.allMembers === true, allApplicants: audience.allApplicants === true, departmentIds: [...departmentIds], memberCount: memberIds.size, applicantCount: applicationIds.size, includeManagers: audience.includeManagers === true, includeDefaultRecipients: audience.includeDefaultRecipients === true, customEmailCount: Array.isArray(audience.customEmails) ? audience.customEmails.length : 0 });
    response.status(201).json({ ok: true, notification: record });
  } catch (error) {
    console.error("Notification delivery failed", error.message);
    appendAudit(request, request.adminUser, "notification.failed", subject, { recipientCount: recipients.length });
    response.status(502).json({ error: "邮件通知发送失败，请检查 SMTP 通道" });
  }
});
app.get("/api/admin/managers", requireAdmin, requireRole("owner"), (_request, response) => response.json(readJson(adminFile).map(publicAdmin)));
app.post("/api/admin/managers", requireAdmin, requireRole("owner"), async (request, response) => {
  const memberId = cleanString(request.body.memberId, 80);
  const role = ["owner", "editor", "reviewer"].includes(request.body.role) ? request.body.role : "editor";
  const panelPermissions = normalizeAdminPanelPermissions(request.body.panelPermissions);
  const departmentIds = normalizeAdminDepartmentIds(request.body.departmentIds);
  if (role !== "owner" && (!panelPermissions.length || !departmentIds.length)) return response.status(400).json({ error: "非主管理员必须至少分配一个管理模块和一个负责部门" });
  const result = await withResourceLock(async () => {
    const member = readJson(memberFile).find((item) => item.id === memberId && item.status === "active");
    if (!member) return { status: 404, error: "请选择有效的成员账号" };
    if (member.mustChangePassword === true) return { status: 409, error: "该成员尚未完成一次性激活，不能授予后台权限" };
    const admins = readJson(adminFile);
    if (admins.some((item) => item.memberId === member.id || effectiveAdmin(item).username.toLowerCase() === member.username.toLowerCase())) return { status: 409, error: "该成员已拥有后台管理权限" };
    if (member.email && admins.some((item) => publicAdmin(item).email === member.email)) return { status: 409, error: "该邮箱已绑定其他管理员" };
    const admin = createAdminRecord({ username: member.username, displayName: member.name, email: member.email, memberId: member.id, role, panelPermissions, departmentIds });
    admins.push(admin);
    await writeJson(adminFile, admins);
    return { admin };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const admin = result.admin;
  appendAudit(request, request.adminUser, "manager.create", admin.username, { role, memberId });
  response.status(201).json({ ok: true, manager: publicAdmin(admin) });
});
app.patch("/api/admin/managers/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const admins = readJson(adminFile);
    const admin = admins.find((item) => item.id === request.params.id);
    if (!admin) return { status: 404, error: "管理员不存在" };
    const currentAdmin = effectiveAdmin(admin);
    const nextRole = ["owner", "editor", "reviewer"].includes(request.body.role) ? request.body.role : admin.role;
    const nextStatus = ["active", "disabled"].includes(request.body.status) ? request.body.status : admin.status === "disabled" ? "disabled" : "active";
    const submittedEmail = admin.memberId ? currentAdmin.email : request.body.email === undefined ? currentAdmin.email : cleanString(request.body.email, 120);
    const nextEmail = cleanEmail(submittedEmail);
    if (submittedEmail && !nextEmail) return { status: 400, error: "请填写单个有效邮箱地址" };
    if (nextEmail && admins.some((item) => item.id !== admin.id && publicAdmin(item).email === nextEmail)) return { status: 409, error: "该邮箱已绑定其他管理员" };
    if (admin.id === request.adminUser.id && nextStatus === "disabled") return { status: 400, error: "不能停用当前登录账号" };
    const activeOwnerCount = admins.filter((item) => item.role === "owner" && isActiveAdmin(item) && item.id !== admin.id).length;
    if (admin.role === "owner" && isActiveAdmin(admin) && (nextRole !== "owner" || nextStatus === "disabled") && activeOwnerCount === 0) return { status: 400, error: "系统至少需要一名可登录的主管理员" };
    const nextPanelPermissions = request.body.panelPermissions === undefined ? normalizeAdminPanelPermissions(admin.panelPermissions) : normalizeAdminPanelPermissions(request.body.panelPermissions);
    const nextDepartmentIds = request.body.departmentIds === undefined ? normalizeAdminDepartmentIds(admin.departmentIds) : normalizeAdminDepartmentIds(request.body.departmentIds);
    if (nextRole !== "owner" && (!nextPanelPermissions.length || !nextDepartmentIds.length)) return { status: 400, error: "非主管理员必须至少分配一个管理模块和一个负责部门" };
    if (request.body.password && String(request.body.password).length < 8) return { status: 400, error: "密码至少需要 8 位" };
    admin.displayName = admin.memberId ? currentAdmin.displayName : request.body.displayName === undefined ? admin.displayName : cleanString(request.body.displayName, 60);
    admin.email = nextEmail;
    admin.role = nextRole;
    admin.status = nextStatus;
    admin.panelPermissions = nextPanelPermissions;
    admin.departmentIds = nextDepartmentIds;
    if (request.body.password) {
      if (admin.memberId) {
        const members = readJson(memberFile);
        const member = members.find((item) => item.id === admin.memberId);
        if (!member) return { status: 409, error: "关联成员账号不存在" };
        member.salt = crypto.randomBytes(16).toString("hex");
        member.passwordHash = passwordHash(request.body.password, member.salt);
        member.mustChangePassword = false;
        member.updatedAt = new Date().toISOString();
        await writeJson(memberFile, members);
      } else {
        admin.salt = crypto.randomBytes(16).toString("hex");
        admin.passwordHash = passwordHash(request.body.password, admin.salt);
      }
    }
    admin.updatedAt = new Date().toISOString();
    await writeJson(adminFile, admins);
    await invalidateAdminEmailApprovalTokens(admin.id, "admin-updated", admin.updatedAt);
    return { admin };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const admin = result.admin;
  if (admin.status === "disabled" || request.body.password) for (const [token, session] of sessions) if (session.user.id === admin.id) sessions.delete(token);
  appendAudit(request, request.adminUser, "manager.update", admin.username, { role: admin.role, status: admin.status, passwordChanged: Boolean(request.body.password) });
  response.json({ ok: true, manager: publicAdmin(admin) });
});
app.delete("/api/admin/managers/:id", requireAdmin, requireRole("owner"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const admins = readJson(adminFile);
    const admin = admins.find((item) => item.id === request.params.id);
    if (!admin) return { status: 404, error: "管理员不存在" };
    if (admin.id === request.adminUser.id) return { status: 400, error: "不能删除当前登录账号" };
    if (admin.role === "owner" && isActiveAdmin(admin) && admins.filter((item) => item.id !== admin.id && item.role === "owner" && isActiveAdmin(item)).length === 0) return { status: 400, error: "系统至少需要一名可登录的主管理员" };
    await writeJson(adminFile, admins.filter((item) => item.id !== admin.id));
    await invalidateAdminEmailApprovalTokens(admin.id, "admin-deleted");
    return { admin };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const admin = result.admin;
  for (const [token, session] of sessions) if (session.user.id === admin.id) sessions.delete(token);
  appendAudit(request, request.adminUser, "manager.delete", admin.username);
  response.json({ ok: true });
});
app.get("/api/admin/members", requireAdmin, requirePanel("members"), requireRole("owner", "editor", "reviewer"), (request, response) => response.json(filterByDepartment(request.adminUser, readJson(memberFile)).map(publicMember)));
app.post("/api/admin/members", requireAdmin, requirePanel("members"), requireRole("owner", "editor"), async (request, response) => {
  const departmentId = cleanString(request.body.departmentId, 50);
  if (!canAccessDepartment(request.adminUser, departmentId)) return response.status(404).json({ error: "负责部门不存在" });
  const username = assignedMemberUsername(departmentId, request.body.studentId);
  if (!username) return response.status(400).json({ error: "请填写有效学号，并为部门设置账号简写" });
  const result = await withResourceLock(async () => {
    const members = readJson(memberFile);
    if (members.some((item) => item.username.toLowerCase() === username.toLowerCase())) return { status: 409, error: "该成员账号已存在" };
    const member = createMemberRecord({ ...request.body, username, permissions: Array.isArray(request.body.permissions) ? request.body.permissions : [] });
    members.push(member);
    await writeJson(memberFile, members);
    const activation = await issueMemberActivationCode(member);
    return { member, activation };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const { member, activation } = result;
  const activationNotified = await sendMemberActivationEmail(member, activation);
  appendAudit(request, request.adminUser, "member.create", username, { permissions: member.permissions });
  response.status(201).json({ ok: true, member: publicMember(member), activationCode: activation.code, activationExpiresAt: activation.expiresAt, activationNotified });
});
app.patch("/api/admin/members/:id", requireAdmin, requirePanel("members"), requireRole("owner", "editor"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const members = readJson(memberFile);
    const member = members.find((item) => item.id === request.params.id);
    if (!member || !canAccessDepartment(request.adminUser, member.departmentId)) return { status: 404, error: "成员不存在" };
    const admins = readJson(adminFile);
    const linkedAdmins = admins.filter((admin) => admin.memberId === member.id);
    const changesLinkedIdentity = ["password", "status", "studentId", "departmentId", "email", "name"].some((field) => request.body[field] !== undefined);
    if (linkedAdmins.length && request.adminUser.role !== "owner" && changesLinkedIdentity) return { status: 403, error: "只有主管理员可以修改后台账号关联的身份、状态或密码" };
    if (request.body.status === "suspended" && linkedAdmins.some((admin) => admin.id === request.adminUser.id)) return { status: 400, error: "不能停用当前登录账号" };
    const disablesLinkedOwner = request.body.status === "suspended";
    if (disablesLinkedOwner && linkedAdmins.some((admin) => admin.role === "owner" && isActiveAdmin(admin))) {
      const linkedIds = new Set(linkedAdmins.map((admin) => admin.id));
      if (!admins.some((admin) => !linkedIds.has(admin.id) && admin.role === "owner" && isActiveAdmin(admin))) return { status: 400, error: "系统至少需要一名可登录的主管理员" };
    }
    const nextDepartmentId = request.body.departmentId === undefined ? member.departmentId : cleanString(request.body.departmentId, 50);
    const nextStudentId = request.body.studentId === undefined ? member.studentId : cleanString(request.body.studentId, 30);
    if (!canAccessDepartment(request.adminUser, nextDepartmentId)) return { status: 404, error: "负责部门不存在" };
    if (request.body.email !== undefined && cleanString(request.body.email, 120) && !cleanEmail(request.body.email)) return { status: 400, error: "成员邮箱格式无效" };
    const nextEmail = request.body.email === undefined ? member.email : cleanEmail(request.body.email);
    if (linkedAdmins.length && nextEmail && admins.some((admin) => !linkedAdmins.some((linked) => linked.id === admin.id) && publicAdmin(admin).email === nextEmail)) return { status: 409, error: "该邮箱已绑定其他管理员" };
    if (request.body.password && String(request.body.password).length < 8) return { status: 400, error: "成员密码至少需要 8 位" };
    if (request.body.password && member.mustChangePassword === true) return { status: 409, error: "未激活账号必须使用一次性激活码设置密码" };
    if (member.accountScheme === "department-student") {
      const nextUsername = assignedMemberUsername(nextDepartmentId, nextStudentId);
      if (!nextUsername) return { status: 400, error: "请填写有效学号，并为部门设置账号简写" };
      if (members.some((item) => item.id !== member.id && item.username.toLowerCase() === nextUsername.toLowerCase())) return { status: 409, error: "更新后的成员账号已存在" };
      member.username = nextUsername;
    }
    if (request.body.name !== undefined) member.name = cleanString(request.body.name, 60);
    member.studentId = nextStudentId;
    if (request.body.className !== undefined) member.className = cleanString(request.body.className, 60);
    if (request.body.email !== undefined) member.email = nextEmail;
    if (request.body.contact !== undefined) member.contact = cleanString(request.body.contact, 80);
    member.departmentId = nextDepartmentId;
    if (Array.isArray(request.body.permissions)) member.permissions = [...new Set(request.body.permissions.map((item) => cleanString(item, 80).toLowerCase()).filter(Boolean))].slice(0, 100);
    if (["active", "suspended"].includes(request.body.status)) member.status = request.body.status;
    if (request.body.password) {
      member.salt = crypto.randomBytes(16).toString("hex");
      member.passwordHash = passwordHash(request.body.password, member.salt);
      member.mustChangePassword = false;
    }
    member.updatedAt = new Date().toISOString();
    await writeJson(memberFile, members);
    for (const admin of linkedAdmins) await invalidateAdminEmailApprovalTokens(admin.id, "linked-member-updated", member.updatedAt);
    return { member, linkedAdmins };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const { member, linkedAdmins } = result;
  if (member.status !== "active" || request.body.password) for (const [token, session] of memberSessions) if (session.member.id === member.id) memberSessions.delete(token);
  if (member.status !== "active" || request.body.password) for (const [token, session] of sessions) if (linkedAdmins.some((admin) => admin.id === session.user.id)) sessions.delete(token);
  appendAudit(request, request.adminUser, "member.update", member.username, { permissions: member.permissions, status: member.status, passwordChanged: Boolean(request.body.password) });
  response.json({ ok: true, member: publicMember(member) });
});
app.post("/api/admin/members/:id/activation-code", requireAdmin, requirePanel("members"), requireRole("owner", "editor"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const member = readJson(memberFile).find((item) => item.id === request.params.id);
    if (!member || !canAccessDepartment(request.adminUser, member.departmentId)) return { status: 404, error: "成员不存在" };
    if (member.status !== "active" || member.mustChangePassword !== true) return { status: 409, error: "只有尚未激活的有效成员可以重新签发激活码" };
    return { member, activation: await issueMemberActivationCode(member) };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const activationNotified = await sendMemberActivationEmail(result.member, result.activation);
  appendAudit(request, request.adminUser, "member.activation.reissue", result.member.username, { expiresAt: result.activation.expiresAt, notified: activationNotified });
  response.json({ ok: true, activationCode: result.activation.code, activationExpiresAt: result.activation.expiresAt, activationNotified });
});
app.delete("/api/admin/members/:id", requireAdmin, requirePanel("members"), requireRole("owner"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const members = readJson(memberFile);
    const member = members.find((item) => item.id === request.params.id);
    if (!member) return { status: 404, error: "成员不存在" };
    if (readJson(adminFile).some((admin) => admin.memberId === member.id)) return { status: 409, error: "请先删除该成员的后台管理权限" };
    await writeJson(memberFile, members.filter((item) => item.id !== member.id));
    const records = readJson(memberActivationCodeFile);
    const invalidatedAt = new Date().toISOString();
    let changed = false;
    records.forEach((record) => {
      if (record.memberId === member.id && !record.usedAt && !record.invalidatedAt) {
        changed = true;
        record.invalidatedAt = invalidatedAt;
        record.invalidatedReason = "member-deleted";
      }
    });
    if (changed) await writeJson(memberActivationCodeFile, records);
    return { member };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const member = result.member;
  for (const [token, session] of memberSessions) if (session.member.id === member.id) memberSessions.delete(token);
  appendAudit(request, request.adminUser, "member.delete", member.username);
  response.json({ ok: true });
});
app.post("/api/admin/applications/:id/promote", requireAdmin, requirePanel("applications"), requireRole("owner", "editor"), async (request, response) => {
  if (!hasAdminPanel(request.adminUser, "members")) return response.status(403).json({ error: "转为成员还需要人员管理权限" });
  const result = await withResourceLock(async () => {
    const applications = readJson(applicationFile);
    const application = applications.find((item) => item.id === request.params.id);
    if (!application || !canAccessDepartment(request.adminUser, application.departmentId)) return { status: 404, error: "申请不存在" };
    if (application.status !== "accepted") return { status: 409, error: "只有已通过的申请可以转为成员" };
    if (application.memberId) return { status: 409, error: "该申请已转为成员" };
    const members = readJson(memberFile);
    const username = assignedMemberUsername(application.departmentId, application.studentId);
    if (!username) return { status: 400, error: "申请资料中的学号无效，或部门未设置账号简写" };
    if (members.some((item) => item.username.toLowerCase() === username.toLowerCase())) return { status: 409, error: "该成员账号已存在" };
    const member = createMemberRecord({ username, name: application.name, studentId: application.studentId, className: application.className, email: application.email, contact: application.contact, departmentId: application.departmentId, permissions: Array.isArray(request.body.permissions) ? request.body.permissions : [] });
    members.push(member);
    application.status = "accepted";
    application.memberId = member.id;
    application.updatedAt = new Date().toISOString();
    await writeJson(memberFile, members);
    await writeJson(applicationFile, applications);
    const activation = await issueMemberActivationCode(member);
    return { application, member, username, activation };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  const { application, member, username, activation } = result;
  const activationNotified = await sendMemberActivationEmail(member, activation);
  appendAudit(request, request.adminUser, "application.promote", application.id, { memberId: member.id, username });
  response.status(201).json({ ok: true, member: publicMember(member), application, activationCode: activation.code, activationExpiresAt: activation.expiresAt, activationNotified });
});
app.get("/api/admin/inventory", requireAdmin, requirePanel("inventory"), requireRole("owner", "editor", "reviewer"), (_request, response) => response.json({ items: readJson(inventoryFile), ledger: readJson(inventoryLedgerFile).slice(0, 500) }));
app.post("/api/admin/inventory", requireAdmin, requirePanel("inventory"), requireRole("owner", "editor"), async (request, response) => {
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
app.patch("/api/admin/inventory/:id", requireAdmin, requirePanel("inventory"), requireRole("owner", "editor"), async (request, response) => {
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
app.delete("/api/admin/inventory/:id", requireAdmin, requirePanel("inventory"), requireRole("owner"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const inventory = readJson(inventoryFile);
    const item = inventory.find((entry) => entry.id === request.params.id);
    if (!item) return { status: 404, error: "材料不存在" };
    if (readJson(usageRequestFile).some((usageRequest) => usageRequest.type === "material" && usageRequest.targetId === item.id && usageRequest.status === "pending")) return { status: 409, error: "该材料仍有待审批申请，不能删除" };
    await writeJson(inventoryFile, inventory.filter((entry) => entry.id !== item.id));
    if (item.quantity > 0) {
      const ledger = readJson(inventoryLedgerFile);
      ledger.unshift({ id: `MATLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, itemId: item.id, itemName: item.name, direction: "out", quantity: item.quantity, unit: item.unit, reason: "删除材料记录并核销剩余库存", actor: request.adminUser, createdAt: new Date().toISOString() });
      await writeJson(inventoryLedgerFile, ledger.slice(0, 10000));
    }
    return { item };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, request.adminUser, "inventory.delete", result.item.id, { name: result.item.name, quantity: result.item.quantity, unit: result.item.unit });
  response.json({ ok: true, item: result.item });
});
app.post("/api/admin/inventory/:id/restock", requireAdmin, requirePanel("inventory"), requireRole("owner", "editor"), async (request, response) => {
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
app.get("/api/admin/funds", requireAdmin, requirePanel("funds"), requireRole("owner", "editor", "reviewer"), (_request, response) => response.json(readJson(fundFile)));
app.post("/api/admin/funds", requireAdmin, requirePanel("funds"), requireRole("owner"), async (request, response) => {
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
app.patch("/api/admin/funds/:id", requireAdmin, requirePanel("funds"), requireRole("owner"), async (request, response) => {
  const account = await withResourceLock(async () => {
    const funds = readJson(fundFile);
    const target = funds.accounts.find((entry) => entry.id === request.params.id);
    if (!target) return null;
    if (request.body.name !== undefined) target.name = cleanString(request.body.name, 120) || target.name;
    if (request.body.notes !== undefined) target.notes = cleanString(request.body.notes, 500);
    if (["active", "archived"].includes(request.body.status)) target.status = request.body.status;
    target.updatedAt = new Date().toISOString();
    await writeJson(fundFile, funds);
    return target;
  });
  if (!account) return response.status(404).json({ error: "资金账户不存在" });
  appendAudit(request, request.adminUser, "fund.update", account.id, { status: account.status });
  response.json({ ok: true, account });
});
app.delete("/api/admin/funds/:id", requireAdmin, requirePanel("funds"), requireRole("owner"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const funds = readJson(fundFile);
    const account = funds.accounts.find((entry) => entry.id === request.params.id);
    if (!account) return { status: 404, error: "资金账户不存在" };
    if (readJson(usageRequestFile).some((usageRequest) => usageRequest.type === "fund" && usageRequest.targetId === account.id && usageRequest.status === "pending")) return { status: 409, error: "该资金账户仍有待审批申请，不能删除" };
    funds.accounts = funds.accounts.filter((entry) => entry.id !== account.id);
    if (account.balance > 0) funds.ledger.unshift({ id: `FUNDLOG-${crypto.randomBytes(6).toString("hex").toUpperCase()}`, accountId: account.id, accountName: account.name, direction: "out", amount: account.balance, currency: account.currency, reason: "删除资金账户并核销剩余余额", actor: request.adminUser, createdAt: new Date().toISOString() });
    funds.ledger = funds.ledger.slice(0, 10000);
    await writeJson(fundFile, funds);
    return { account };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, request.adminUser, "fund.delete", result.account.id, { name: result.account.name, balance: result.account.balance, currency: result.account.currency });
  response.json({ ok: true, account: result.account });
});
app.post("/api/admin/funds/:id/topup", requireAdmin, requirePanel("funds"), requireRole("owner"), async (request, response) => {
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
app.get("/api/admin/usage-requests", requireAdmin, requirePanel("usage"), requireRole("owner", "editor", "reviewer"), (request, response) => response.json(readJson(usageRequestFile).filter((usageRequest) => canAccessDepartment(request.adminUser, usageRequestDepartmentId(usageRequest)))));
app.patch("/api/admin/usage-requests/:id", requireAdmin, requirePanel("usage"), requireRole("owner", "reviewer"), async (request, response) => {
  const decision = request.body.decision;
  const reviewNote = cleanString(request.body.reviewNote, 500);
  if (!['approved', 'rejected'].includes(decision)) return response.status(400).json({ error: "审批结果无效" });
  const result = await processUsageDecision({ requestId: request.params.id, decision, reviewNote, adminUser: request.adminUser });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, result.adminUser, `usage.${decision}`, result.usageRequest.id, { type: result.usageRequest.type, targetId: result.usageRequest.targetId });
  const notified = await sendUsageDecisionEmail(result.usageRequest, decision, reviewNote, result.adminUser);
  response.json({ ok: true, notified, request: result.usageRequest });
});
app.get("/api/admin/audit", requireAdmin, requirePanel("audit"), (request, response) => {
  const limit = Math.max(1, Math.min(Number(request.query.limit) || 200, 500));
  response.json((request.adminUser.role === "owner" ? auditEntries : auditEntries.filter((entry) => entry.actor?.id === request.adminUser.id)).slice(0, limit));
});
app.get("/api/admin/sync", requireAdmin, (request, response) => {
  const content = readJson(contentFile);
  const applications = filterByDepartment(request.adminUser, readJson(applicationFile));
  const members = filterByDepartment(request.adminUser, readJson(memberFile));
  const notifications = readJson(notificationFile).filter((item) => request.adminUser.role === "owner" || item.sentBy?.id === request.adminUser.id);
  const memberMessages = filterByDepartment(request.adminUser, readJson(memberMessageFile));
  const inventory = readJson(inventoryFile);
  const funds = readJson(fundFile);
  const usageRequests = readJson(usageRequestFile).filter((usageRequest) => canAccessDepartment(request.adminUser, usageRequestDepartmentId(usageRequest)));
  const applicationUpdatedAt = applications.reduce((latest, item) => {
    const timestamp = item.updatedAt || item.createdAt || "";
    return timestamp > latest ? timestamp : latest;
  }, "");
  const result = { user: request.adminUser };
  if (["settings", "projects", "departments", "resources"].some((panel) => hasAdminPanel(request.adminUser, panel))) result.content = content._meta || { revision: 0, updatedAt: null, updatedBy: null };
  if (hasAdminPanel(request.adminUser, "applications") || hasAdminPanel(request.adminUser, "notifications")) result.applications = { total: applications.length, new: applications.filter((item) => item.status === "new").length, updatedAt: applicationUpdatedAt || null };
  if (hasAdminPanel(request.adminUser, "members") || hasAdminPanel(request.adminUser, "notifications")) result.members = { total: members.length, active: members.filter((item) => item.status === "active").length, updatedAt: members.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null };
  if (hasAdminPanel(request.adminUser, "notifications")) result.notifications = { total: notifications.length, latestId: notifications[0]?.id || null, latestAt: notifications[0]?.sentAt || null };
  if (hasAdminPanel(request.adminUser, "notifications")) result.memberMessages = { total: memberMessages.length, open: memberMessages.filter((thread) => thread.status === "open").length, updatedAt: memberMessages.reduce((latest, thread) => (thread.updatedAt || thread.createdAt || "") > latest ? (thread.updatedAt || thread.createdAt || "") : latest, "") || null };
  if (hasAdminPanel(request.adminUser, "inventory")) result.inventory = { total: inventory.length, updatedAt: inventory.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null };
  if (hasAdminPanel(request.adminUser, "funds")) result.funds = { total: funds.accounts.length, updatedAt: funds.accounts.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null };
  if (hasAdminPanel(request.adminUser, "usage")) result.usageRequests = { total: usageRequests.length, pending: usageRequests.filter((item) => item.status === "pending").length, updatedAt: usageRequests.reduce((latest, item) => (item.updatedAt || item.createdAt || "") > latest ? (item.updatedAt || item.createdAt || "") : latest, "") || null };
  if (hasAdminPanel(request.adminUser, "audit")) {
    const visibleAudit = request.adminUser.role === "owner" ? auditEntries : auditEntries.filter((entry) => entry.actor?.id === request.adminUser.id);
    result.audit = { latestId: visibleAudit[0]?.id || null, latestAt: visibleAudit[0]?.timestamp || null };
  }
  response.json(result);
});
app.get("/api/admin/applications", requireAdmin, requirePanel("applications"), (request, response) => response.json(filterByDepartment(request.adminUser, readJson(applicationFile))));
app.post("/api/admin/applications/:id/send-approval-email", requireAdmin, requirePanel("applications"), requireRole("owner", "editor", "reviewer"), async (request, response) => {
  const application = readJson(applicationFile).find((item) => item.id === request.params.id);
  if (!application || !canReviewApplication(readJson(adminFile).find((admin) => admin.id === request.adminUser.id), application)) return response.status(404).json({ error: "申请不存在或超出负责范围" });
  if (["accepted", "rejected"].includes(application.status)) return response.status(409).json({ error: "已完成审批的申请无需重新发送" });
  const rateLimit = consumeRateLimits([{ key: `application-approval-email:${request.adminUser.id}:${application.id}`, limit: 5, interval: 60 * 60 * 1000, scope: "application" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "该申请一小时内重发审批邮件较多，请稍后再试" });
  }
  const notified = await sendApplicationApprovalEmails(application);
  appendAudit(request, request.adminUser, "application.approval_email.reissue", application.id, { notified });
  response.json({ ok: true, notified });
});
app.patch("/api/admin/applications/:id", requireAdmin, requirePanel("applications"), requireRole("owner", "editor", "reviewer"), async (request, response) => {
  const statuses = new Set(["new", "reviewing", "accepted", "rejected"]);
  const status = cleanString(request.body.status, 20);
  if (!statuses.has(status)) return response.status(400).json({ error: "状态无效" });
  const reviewNote = cleanString(request.body.reviewNote, 500);
  if (["accepted", "rejected"].includes(status)) {
    const result = await processApplicationDecision({ applicationId: request.params.id, decision: status, reviewNote, adminUser: request.adminUser });
    if (result.error) return response.status(result.status).json({ error: result.error });
    appendAudit(request, result.adminUser, `application.${status}`, result.application.id, { departmentId: result.application.departmentId });
    const notified = await sendApplicationDecisionEmail(result.application, status, reviewNote, result.adminUser);
    return response.json({ ok: true, notified, application: result.application });
  }
  const result = await withResourceLock(async () => {
    const applications = readJson(applicationFile);
    const application = applications.find((item) => item.id === request.params.id);
    if (!application || !canAccessDepartment(request.adminUser, application.departmentId)) return { status: 404, error: "申请不存在" };
    if (["accepted", "rejected"].includes(application.status)) return { status: 409, error: "已完成审批的申请不能改回待处理状态" };
    application.status = status;
    application.updatedAt = new Date().toISOString();
    await writeJson(applicationFile, applications);
    return { application };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, request.adminUser, "application.status", result.application.id, { status });
  response.json({ ok: true, application: result.application });
});
app.delete("/api/admin/applications/:id", requireAdmin, requirePanel("applications"), requireRole("owner"), async (request, response) => {
  const result = await withResourceLock(async () => {
    const applications = readJson(applicationFile);
    const remaining = applications.filter((item) => item.id !== request.params.id);
    if (remaining.length === applications.length) return { status: 404, error: "申请不存在" };
    await writeJson(applicationFile, remaining);
    const records = readJson(emailApprovalTokenFile);
    const invalidatedAt = new Date().toISOString();
    records.forEach((record) => {
      if (record.kind === "application" && record.requestId === request.params.id && !record.usedAt && !record.invalidatedAt) {
        record.invalidatedAt = invalidatedAt;
        record.invalidatedReason = "application-deleted";
      }
    });
    await writeJson(emailApprovalTokenFile, records);
    return { ok: true };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, request.adminUser, "application.delete", request.params.id);
  response.json({ ok: true });
});
app.post("/api/admin/upload", requireAdmin, requirePanel("uploads"), requireRole("owner", "editor"), upload.single("file"), (request, response) => {
  if (!request.file) return response.status(400).json({ error: "请选择 JPG、PNG、WebP、AVIF、MP4 或 WebM 文件" });
  appendAudit(request, request.adminUser, "media.upload", request.file.filename, { bytes: request.file.size, mime: request.file.mimetype });
  response.status(201).json({ ok: true, url: `/uploads/${request.file.filename}` });
});
app.post("/api/bug-report", async (request, response) => {
  if (!sameOrigin(request, true)) return response.status(403).json({ error: "跨站请求被拒绝" });
  const title = cleanString(request.body.title, 120);
  const description = cleanString(request.body.description, 2000);
  const contact = cleanString(request.body.contact, 120);
  if (title.length < 3 || description.length < 5) return response.status(400).json({ error: "请填写标题（至少 3 个字符）和详细描述（至少 5 个字符）" });
  const rateLimit = consumeRateLimits([{ key: `bug-report:${request.ip}`, limit: 5, interval: 60 * 60 * 1000, scope: "network" }]);
  if (!rateLimit.allowed) {
    response.set("Retry-After", String(rateLimit.retryAfter));
    return response.status(429).json({ error: "提交过于频繁，请稍后再试" });
  }
  const report = { id: `BUG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`, title, description, contact, status: "open", createdAt: new Date().toISOString() };
  await withResourceLock(async () => {
    const reports = readJson(bugReportFile);
    reports.unshift(report);
    await writeJson(bugReportFile, reports.slice(0, 2000));
  });
  response.status(201).json({ ok: true, report: { id: report.id, title: report.title, status: report.status, createdAt: report.createdAt } });
});
app.get("/api/admin/bug-reports", requireAdmin, (request, response) => {
  response.json(readJson(bugReportFile));
});
app.patch("/api/admin/bug-reports/:id", requireAdmin, async (request, response) => {
  const result = await withResourceLock(async () => {
    const reports = readJson(bugReportFile);
    const report = reports.find((item) => item.id === request.params.id);
    if (!report) return { status: 404, error: "报告不存在" };
    if (request.body.status && ["open", "resolved"].includes(request.body.status)) report.status = request.body.status;
    report.updatedAt = new Date().toISOString();
    await writeJson(bugReportFile, reports);
    return { report };
  });
  if (result.error) return response.status(result.status).json({ error: result.error });
  appendAudit(request, request.adminUser, "bug-report.update", result.report.id, { status: result.report.status });
  response.json({ ok: true, report: result.report });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) return response.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "文件不能超过 100MB" : "上传失败" });
  response.status(500).json({ error: "服务器暂时无法处理请求" });
});

app.listen(port, "127.0.0.1", () => console.log(`Tech Club CMS listening on 127.0.0.1:${port}`));
