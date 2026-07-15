import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3105";
const dataDirectory = "/tmp/tech-club-email-approval-test";
const ownerPassword = "isolated-owner-password";
const reviewerPassword = "isolated-reviewer-password";
const memberPassword = "isolated-member-password";
const sessionSecret = "isolated-email-approval-secret";
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

await fs.rm(dataDirectory, { recursive: true, force: true });
const server = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: "3105", DATA_DIR: dataDirectory, ADMIN_PASSWORD: ownerPassword, MANAGER_EMAIL: "owner@example.com", SESSION_SECRET: sessionSecret, COOKIE_SECURE: "false", PUBLIC_BASE_URL: base }, stdio: ["ignore", "pipe", "pipe"] });
let serverErrors = "";
server.stderr.on("data", (chunk) => { serverErrors += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated server did not start: ${serverErrors}`);
}

async function request(endpoint, options = {}) {
  const response = await fetch(`${base}${endpoint}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function loginAdmin(username, password) {
  const result = await request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(result.response.status, 200);
  return { cookie: result.response.headers.getSetCookie()[0].split(";", 1)[0], csrf: result.body.csrf };
}

function rawToken(fill) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function tokenRecord(token, requestId, adminId, action, expiresAt, suffix) {
  return { id: `MAILAPP-${suffix}`, tokenHash: crypto.createHmac("sha256", sessionSecret).update(token).digest("hex"), requestId, adminId, action, expiresAt, createdAt: new Date().toISOString() };
}

try {
  await waitForServer();
  const owner = await loginAdmin("admin", ownerPassword);
  const ownerHeaders = { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf };
  const reviewerResult = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ username: "email-reviewer", password: reviewerPassword, displayName: "邮件审批人", email: "reviewer@example.com", role: "reviewer", panelPermissions: ["usage"], departmentIds: ["software"] }) });
  assert.equal(reviewerResult.response.status, 201);
  const reviewer = reviewerResult.body.manager;
  const material = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "邮件审批材料", unit: "件", quantity: 20 }) });
  const member = await request("/api/admin/members", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ username: "email-requester", password: memberPassword, name: "邮件申请成员", departmentId: "software", permissions: ["material.request"] }) });
  assert.equal(material.response.status, 201);
  assert.equal(member.response.status, 201);
  const memberLogin = await request("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "email-requester", password: memberPassword }) });
  const memberCookie = memberLogin.response.headers.getSetCookie()[0].split(";", 1)[0];

  async function submitUsage(quantity, purpose) {
    const result = await request("/api/member/usage-requests", { method: "POST", headers: { cookie: memberCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity, purpose }) });
    assert.equal(result.response.status, 201);
    return result.body.request;
  }

  const usageRequest = await submitUsage(3, "验证邮件审批确认流程");
  const approveToken = rawToken(1);
  const rejectToken = rawToken(2);
  const concurrentApproveToken = rawToken(5);
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const tokenFile = path.join(dataDirectory, "email-approval-tokens.json");
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(approveToken, usageRequest.id, reviewer.id, "approved", future, "APPROVE"), tokenRecord(concurrentApproveToken, usageRequest.id, reviewer.id, "approved", future, "CONCURRENT"), tokenRecord(rejectToken, usageRequest.id, reviewer.id, "rejected", future, "REJECT")], null, 2)}\n`);
  assert.equal((await fs.readFile(tokenFile, "utf8")).includes(approveToken), false, "raw token was persisted");

  const preload = await request("/api/email-approvals/preview");
  assert.equal(preload.response.status, 404);
  const preview = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: approveToken }) });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.approval.action, "approved");
  let inventory = await request("/api/admin/inventory", { headers: { cookie: owner.cookie } });
  assert.equal(inventory.body.items.find((item) => item.id === material.body.item.id).quantity, 20, "preview changed inventory");

  const concurrentConfirmations = await Promise.all([approveToken, concurrentApproveToken].map((token) => request("/api/email-approvals/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, reviewNote: "邮件确认批准" }) })));
  assert.deepEqual(concurrentConfirmations.map((confirmation) => confirmation.response.status).sort(), [200, 410]);
  const confirmed = concurrentConfirmations.find((confirmation) => confirmation.response.status === 200);
  assert.equal(confirmed.body.request.reviewedVia, "email");
  inventory = await request("/api/admin/inventory", { headers: { cookie: owner.cookie } });
  assert.equal(inventory.body.items.find((item) => item.id === material.body.item.id).quantity, 17);
  const replay = await request("/api/email-approvals/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: approveToken }) });
  assert.equal(replay.response.status, 410);
  const alternateAction = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: rejectToken }) });
  assert.equal(alternateAction.response.status, 410);

  const revokedRequest = await submitUsage(2, "验证撤销审批权限后链接失效");
  const revokedToken = rawToken(3);
  const expiredToken = rawToken(4);
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(revokedToken, revokedRequest.id, reviewer.id, "approved", future, "REVOKED"), tokenRecord(expiredToken, revokedRequest.id, reviewer.id, "approved", new Date(Date.now() - 1000).toISOString(), "EXPIRED")], null, 2)}\n`);
  const expired = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: expiredToken }) });
  assert.equal(expired.response.status, 410);
  const revoke = await request(`/api/admin/managers/${reviewer.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "reviewer", panelPermissions: ["members"], departmentIds: ["software"] }) });
  assert.equal(revoke.response.status, 200);
  const revoked = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: revokedToken }) });
  assert.equal(revoked.response.status, 403);

  const audit = await request("/api/admin/audit?limit=200", { headers: { cookie: owner.cookie } });
  assert.ok(audit.body.some((entry) => entry.action === "usage.email.approved" && entry.target === usageRequest.id));
  console.log(JSON.stringify({ ok: true, previewDidNotMutate: true, tokenHashOnly: true, concurrentSingleExecution: true, singleUse: true, alternateInvalidated: true, expirationEnforced: true, revocationEnforced: true, auditRecorded: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
