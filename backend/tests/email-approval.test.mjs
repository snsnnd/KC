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

async function activateMember(created, nextPassword) {
  const activated = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: created.member.username, activationCode: created.activationCode, nextPassword }) });
  assert.equal(activated.response.status, 200);
  const replay = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: created.member.username, activationCode: created.activationCode, nextPassword }) });
  assert.equal(replay.response.status, 400);
  const login = await request("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: created.member.username, password: nextPassword }) });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.getSetCookie()[0].split(";", 1)[0];
  return cookie;
}

function rawToken(fill) {
  return Buffer.alloc(32, fill).toString("base64url");
}

function tokenRecord(token, requestId, admin, action, expiresAt, suffix, kind = "usage") {
  return { id: `MAILAPP-${suffix}`, kind, tokenHash: crypto.createHmac("sha256", sessionSecret).update(token).digest("hex"), requestId, adminId: admin.id, adminEmail: admin.email, adminVersion: `${admin.updatedAt || admin.createdAt || ""}:${admin.memberUpdatedAt || ""}`, action, expiresAt, createdAt: new Date().toISOString() };
}

try {
  await waitForServer();
  const owner = await loginAdmin("admin", ownerPassword);
  const ownerHeaders = { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf };
  const reviewerMemberResult = await request("/api/admin/members", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "邮件审批人", studentId: "20264001", email: "reviewer@example.com", departmentId: "software", permissions: [] }) });
  assert.equal(reviewerMemberResult.response.status, 201);
  const reviewerMember = reviewerMemberResult.body.member;
  await activateMember(reviewerMemberResult.body, reviewerPassword);
  const reviewerResult = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ memberId: reviewerMember.id, role: "reviewer", panelPermissions: ["usage", "applications"], departmentIds: ["software"] }) });
  assert.equal(reviewerResult.response.status, 201);
  let reviewer = reviewerResult.body.manager;
  assert.ok(reviewer.panelPermissions.includes("notifications"));
  const reviewerSession = await loginAdmin(reviewer.username, reviewerPassword);
  const reviewerNotifications = await request("/api/admin/notifications", { headers: { cookie: reviewerSession.cookie } });
  assert.equal(reviewerNotifications.response.status, 200);
  const material = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "邮件审批材料", unit: "件", quantity: 20 }) });
  const fund = await request("/api/admin/funds", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "邮件审批资金", currency: "CNY", balance: 1000 }) });
  const member = await request("/api/admin/members", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "邮件申请成员", studentId: "20264002", email: "requester@example.com", departmentId: "software", permissions: ["material.request", "fund.request"] }) });
  assert.equal(material.response.status, 201);
  assert.equal(fund.response.status, 201);
  assert.equal(member.response.status, 201);
  const memberCookie = await activateMember(member.body, memberPassword);

  async function submitUsage(quantity, purpose) {
    const result = await request("/api/member/usage-requests", { method: "POST", headers: { cookie: memberCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity, purpose }) });
    assert.equal(result.response.status, 201);
    return result.body.request;
  }

  async function submitFund(amount, purpose) {
    const result = await request("/api/member/usage-requests", { method: "POST", headers: { cookie: memberCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "fund", targetId: fund.body.account.id, amount, purpose }) });
    assert.equal(result.response.status, 201);
    return result.body.request;
  }

  const usageRequest = await submitUsage(3, "验证邮件审批确认流程");
  const approveToken = rawToken(1);
  const rejectToken = rawToken(2);
  const concurrentApproveToken = rawToken(5);
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const tokenFile = path.join(dataDirectory, "email-approval-tokens.json");
  const linkedMemberData = JSON.parse(await fs.readFile(path.join(dataDirectory, "members.json"), "utf8")).find((item) => item.id === reviewer.memberId);
  reviewer.memberUpdatedAt = linkedMemberData.updatedAt || linkedMemberData.createdAt;
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(approveToken, usageRequest.id, reviewer, "approved", future, "APPROVE"), tokenRecord(concurrentApproveToken, usageRequest.id, reviewer, "approved", future, "CONCURRENT"), tokenRecord(rejectToken, usageRequest.id, reviewer, "rejected", future, "REJECT")], null, 2)}\n`);
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

  const fundRequest = await submitFund(125, "验证资金申请邮件审批流程");
  const fundApproveToken = rawToken(8);
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(fundApproveToken, fundRequest.id, reviewer, "approved", future, "FUND")], null, 2)}\n`);
  const fundPreview = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fundApproveToken }) });
  assert.equal(fundPreview.response.status, 200);
  assert.equal(fundPreview.body.approval.value, "125.00 CNY");
  const fundConfirm = await request("/api/email-approvals/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: fundApproveToken }) });
  assert.equal(fundConfirm.response.status, 200);
  const funds = await request("/api/admin/funds", { headers: { cookie: owner.cookie } });
  assert.equal(funds.body.accounts.find((account) => account.id === fund.body.account.id).balance, 875);

  const joinApplication = await request("/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "邮件加入申请人", studentId: "20264003", className: "测试班级", contact: "join-contact", email: "joiner@example.com", departmentId: "software", motivation: "验证加入申请邮件快速审批流程", consent: "accepted" }) });
  assert.equal(joinApplication.response.status, 201);
  const applicationAcceptToken = rawToken(9);
  const applicationRejectToken = rawToken(10);
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(applicationAcceptToken, joinApplication.body.id, reviewer, "accepted", future, "JOIN-ACCEPT", "application"), tokenRecord(applicationRejectToken, joinApplication.body.id, reviewer, "rejected", future, "JOIN-REJECT", "application")], null, 2)}\n`);
  const applicationPreview = await request("/api/application-email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: applicationAcceptToken }) });
  assert.equal(applicationPreview.response.status, 200);
  assert.equal(applicationPreview.body.approval.kind, "application");
  const applicationConfirm = await request("/api/application-email-approvals/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: applicationAcceptToken, reviewNote: "欢迎加入" }) });
  assert.equal(applicationConfirm.response.status, 200);
  assert.equal(applicationConfirm.body.request.status, "accepted");
  const applicationAlternate = await request("/api/application-email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: applicationRejectToken }) });
  assert.equal(applicationAlternate.response.status, 410);
  const revisedApplication = await request(`/api/admin/applications/${joinApplication.body.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "rejected", reviewNote: "管理员复核后调整结果" }) });
  assert.equal(revisedApplication.response.status, 200);
  assert.equal(revisedApplication.body.application.status, "rejected");

  const revokedRequest = await submitUsage(2, "验证撤销审批权限后链接失效");
  const revokedToken = rawToken(3);
  const expiredToken = rawToken(4);
  const malformedExpiryToken = rawToken(6);
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(revokedToken, revokedRequest.id, reviewer, "approved", future, "REVOKED"), tokenRecord(expiredToken, revokedRequest.id, reviewer, "approved", new Date(Date.now() - 1000).toISOString(), "EXPIRED"), tokenRecord(malformedExpiryToken, revokedRequest.id, reviewer, "approved", "invalid-date", "MALFORMED")], null, 2)}\n`);
  const expired = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: expiredToken }) });
  assert.equal(expired.response.status, 410);
  const malformedExpiry = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: malformedExpiryToken }) });
  assert.equal(malformedExpiry.response.status, 410);
  const revoke = await request(`/api/admin/managers/${reviewer.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "reviewer", panelPermissions: ["members"], departmentIds: ["software"] }) });
  assert.equal(revoke.response.status, 200);
  const revoked = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: revokedToken }) });
  assert.equal(revoked.response.status, 410);

  const restored = await request(`/api/admin/managers/${reviewer.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "reviewer", status: "active", panelPermissions: ["usage"], departmentIds: ["software"] }) });
  assert.equal(restored.response.status, 200);
  reviewer = { ...restored.body.manager, memberUpdatedAt: reviewer.memberUpdatedAt };
  const disabledRequest = await submitUsage(1, "验证审批账号停用后链接失效");
  const disabledToken = rawToken(7);
  await fs.writeFile(tokenFile, `${JSON.stringify([tokenRecord(disabledToken, disabledRequest.id, reviewer, "approved", future, "DISABLED")], null, 2)}\n`);
  const disabled = await request(`/api/admin/managers/${reviewer.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "disabled" }) });
  assert.equal(disabled.response.status, 200);
  const disabledPreview = await request("/api/email-approvals/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: disabledToken }) });
  assert.equal(disabledPreview.response.status, 410);
  const disabledLogin = await request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: reviewer.username, password: reviewerPassword }) });
  assert.equal(disabledLogin.response.status, 401);

  const audit = await request("/api/admin/audit?limit=200", { headers: { cookie: owner.cookie } });
  assert.ok(audit.body.some((entry) => entry.action === "usage.email.approved" && entry.target === usageRequest.id));
  assert.ok(audit.body.some((entry) => entry.action === "usage.email.approved" && entry.target === fundRequest.id && entry.details.approvalMethod === "通过邮件审批"));
  assert.ok(audit.body.some((entry) => entry.action === "application.email.accepted" && entry.target === joinApplication.body.id));
  console.log(JSON.stringify({ ok: true, previewDidNotMutate: true, tokenHashOnly: true, concurrentSingleExecution: true, singleUse: true, alternateInvalidated: true, expirationEnforced: true, malformedExpirationRejected: true, revocationEnforced: true, disabledAccountRejected: true, applicationEmailApproval: true, auditRecorded: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
