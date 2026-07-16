import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3104";
const dataDirectory = "/tmp/tech-club-admin-scope-test";
const ownerPassword = "isolated-owner-password";
const scopedPassword = "isolated-scoped-password";
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

await fs.rm(dataDirectory, { recursive: true, force: true });
const server = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: "3104", DATA_DIR: dataDirectory, ADMIN_PASSWORD: ownerPassword, MANAGER_EMAIL: "owner@example.com", SESSION_SECRET: "isolated-admin-scope-secret", COOKIE_SECURE: "false" }, stdio: ["ignore", "pipe", "pipe"] });
let serverErrors = "";
server.stderr.on("data", (chunk) => { serverErrors += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated server did not start: ${serverErrors}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  return { response, body };
}

async function login(username, password) {
  const result = await request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(result.response.status, 200);
  return { cookie: result.response.headers.getSetCookie()[0].split(";", 1)[0], csrf: result.body.csrf, user: result.body.user };
}

try {
  await waitForServer();
  const owner = await login("admin", ownerPassword);
  const ownerHeaders = { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf };
  const mail = await request("/api/admin/mail", { headers: { cookie: owner.cookie } });
  assert.deepEqual(mail.body.applicationRecipientAdminIds, [owner.user.id]);
  assert.ok(mail.body.usageApprovedSubject.includes("{申请编号}"));
  assert.ok(mail.body.usageRejectedBody.includes("{审批意见}"));
  assert.ok(mail.body.applicationAcceptedSubject.includes("{申请编号}"));
  assert.ok(mail.body.applicationRejectedBody.includes("{审批意见}"));

  const applications = [];
  for (const [departmentId, studentId] of [["software", "20260011"], ["hardware", "20260012"]]) {
    const application = await request("/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${departmentId} applicant`, studentId, className: "测试班级", contact: "test-contact", departmentId, motivation: "这是满足长度要求的申请理由", consent: "accepted" }) });
    assert.equal(application.response.status, 201);
    applications.push(application.body.id);
  }

  const membersByDepartment = {};
  for (const [departmentId, studentId] of [["software", "20263001"], ["hardware", "20263002"]]) {
    const member = await request("/api/admin/members", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: `${departmentId} member`, studentId, departmentId, permissions: [] }) });
    assert.equal(member.response.status, 201);
    membersByDepartment[departmentId] = member.body;
  }

  const prematureManager = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ memberId: membersByDepartment.software.member.id, role: "editor", panelPermissions: ["applications", "members"], departmentIds: ["software"] }) });
  assert.equal(prematureManager.response.status, 409);

  const softwareActivation = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: membersByDepartment.software.member.username, activationCode: membersByDepartment.software.activationCode, nextPassword: scopedPassword }) });
  assert.equal(softwareActivation.response.status, 200);
  const hardwarePassword = "hardware-member-password";
  const hardwareActivation = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: membersByDepartment.hardware.member.username, activationCode: membersByDepartment.hardware.activationCode, nextPassword: hardwarePassword }) });
  assert.equal(hardwareActivation.response.status, 200);
  const noAdminAccess = await request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: membersByDepartment.hardware.member.username, password: hardwarePassword }) });
  assert.equal(noAdminAccess.response.status, 403);

  const createdManager = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ memberId: membersByDepartment.software.member.id, role: "editor", panelPermissions: ["applications", "members"], departmentIds: ["software"] }) });
  assert.equal(createdManager.response.status, 201);
  const managerId = createdManager.body.manager.id;

  const scoped = await login(membersByDepartment.software.member.username, scopedPassword);
  const scopedHeaders = { cookie: scoped.cookie, "content-type": "application/json", "x-csrf-token": scoped.csrf };
  assert.deepEqual(scoped.user.panelPermissions.sort(), ["applications", "members", "notifications"]);
  assert.deepEqual(scoped.user.departmentIds, ["software"]);
  const linkedIdentityUpdate = await request(`/api/admin/members/${membersByDepartment.software.member.id}`, { method: "PATCH", headers: scopedHeaders, body: JSON.stringify({ status: "suspended" }) });
  assert.equal(linkedIdentityUpdate.response.status, 403);

  const softwareMemberLogin = await request("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: membersByDepartment.software.member.username, password: scopedPassword }) });
  const softwareMemberCookie = softwareMemberLogin.response.headers.getSetCookie()[0].split(";", 1)[0];
  const softwareQuestion = await request("/api/member/messages", { method: "POST", headers: { cookie: softwareMemberCookie, "content-type": "application/json" }, body: JSON.stringify({ subject: "软件部问询", message: "软件部管理员应该可以看到" }) });
  assert.equal(softwareQuestion.response.status, 201);
  const hardwareMemberLogin = await request("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: membersByDepartment.hardware.member.username, password: hardwarePassword }) });
  const hardwareMemberCookie = hardwareMemberLogin.response.headers.getSetCookie()[0].split(";", 1)[0];
  const hardwareQuestion = await request("/api/member/messages", { method: "POST", headers: { cookie: hardwareMemberCookie, "content-type": "application/json" }, body: JSON.stringify({ subject: "硬件部问询", message: "软件部管理员不应该看到" }) });
  assert.equal(hardwareQuestion.response.status, 201);
  const scopedMessages = await request("/api/admin/member-messages", { headers: { cookie: scoped.cookie } });
  assert.deepEqual(scopedMessages.body.map((thread) => thread.id), [softwareQuestion.body.thread.id]);
  const crossDepartmentReply = await request(`/api/admin/member-messages/${hardwareQuestion.body.thread.id}/replies`, { method: "POST", headers: scopedHeaders, body: JSON.stringify({ message: "越权回复" }) });
  assert.equal(crossDepartmentReply.response.status, 404);

  const visibleApplications = await request("/api/admin/applications", { headers: { cookie: scoped.cookie } });
  assert.equal(visibleApplications.body.length, 1);
  assert.equal(visibleApplications.body[0].departmentId, "software");
  const notificationAccess = await request("/api/admin/notifications", { headers: { cookie: scoped.cookie } });
  assert.equal(notificationAccess.response.status, 200);
  const visibleMembers = await request("/api/admin/members", { headers: { cookie: scoped.cookie } });
  assert.equal(visibleMembers.body.length, 1);
  assert.equal(visibleMembers.body[0].departmentId, "software");
  const inventory = await request("/api/admin/inventory", { headers: { cookie: scoped.cookie } });
  assert.equal(inventory.response.status, 403);

  const scopedContent = await request("/api/admin/content", { headers: { cookie: scoped.cookie } });
  assert.deepEqual(scopedContent.body.projects, []);
  assert.deepEqual(scopedContent.body.resources, []);
  assert.deepEqual(scopedContent.body.departments.map((department) => department.id), ["software"]);

  const softwareApplication = visibleApplications.body[0];
  const reviewed = await request(`/api/admin/applications/${softwareApplication.id}`, { method: "PATCH", headers: scopedHeaders, body: JSON.stringify({ status: "reviewing" }) });
  assert.equal(reviewed.response.status, 200);
  const hardwareApplicationId = applications.find((id) => id !== softwareApplication.id);
  const crossDepartmentReview = await request(`/api/admin/applications/${hardwareApplicationId}`, { method: "PATCH", headers: scopedHeaders, body: JSON.stringify({ status: "reviewing" }) });
  assert.equal(crossDepartmentReview.response.status, 404);

  const scopedMember = await request("/api/admin/members", { method: "POST", headers: scopedHeaders, body: JSON.stringify({ name: "范围内成员", studentId: "20263003", departmentId: "software", permissions: [] }) });
  assert.equal(scopedMember.response.status, 201);
  const foreignMember = await request("/api/admin/members", { method: "POST", headers: scopedHeaders, body: JSON.stringify({ name: "范围外成员", studentId: "20263004", departmentId: "hardware", permissions: [] }) });
  assert.equal(foreignMember.response.status, 404);

  const revoked = await request(`/api/admin/managers/${managerId}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "editor", panelPermissions: ["members"], departmentIds: ["software"] }) });
  assert.equal(revoked.response.status, 200);
  const revokedApplications = await request("/api/admin/applications", { headers: { cookie: scoped.cookie } });
  assert.equal(revokedApplications.response.status, 403);
  const notificationAudience = await request("/api/admin/notification-audience", { headers: { cookie: scoped.cookie } });
  assert.equal(notificationAudience.response.status, 200);
  assert.ok(notificationAudience.body.applicants.every((application) => application.departmentId === "software"));
  assert.ok(notificationAudience.body.applicants.every((application) => application.motivation === undefined && application.contact === undefined && application.studentId === undefined));
  const revokedApplicationReview = await request(`/api/admin/applications/${softwareApplication.id}`, { method: "PATCH", headers: scopedHeaders, body: JSON.stringify({ status: "reviewing" }) });
  assert.equal(revokedApplicationReview.response.status, 403);
  const sync = await request("/api/admin/sync", { headers: { cookie: scoped.cookie } });
  assert.deepEqual(sync.body.user.panelPermissions.sort(), ["members", "notifications"]);

  console.log(JSON.stringify({ ok: true, moduleIsolation: true, departmentIsolation: true, revocationImmediate: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
