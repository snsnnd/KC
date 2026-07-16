import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3102";
const dataDirectory = "/tmp/tech-club-application-test";
const adminPassword = "isolated-admin-password";
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

await fs.rm(dataDirectory, { recursive: true, force: true });
const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: "3102",
    DATA_DIR: dataDirectory,
    ADMIN_PASSWORD: adminPassword,
    SESSION_SECRET: "isolated-application-profile-test-secret",
    COOKIE_SECURE: "false"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverErrors = "";
server.stderr.on("data", (chunk) => { serverErrors += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated server did not start: ${serverErrors}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  return { response, body };
}

try {
  await waitForServer();
  const [activationPage, activationScript, memberPage] = await Promise.all([
    fs.readFile(new URL("../../public/activate.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/assets/js/activate.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../public/member.html", import.meta.url), "utf8")
  ]);
  assert.match(activationPage, /id="activationForm"/);
  assert.doesNotMatch(activationScript, /api\/member\/login/);
  assert.doesNotMatch(memberPage, /id="memberActivation"/);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const incomplete = await request("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "测试成员", studentId: "20260001", contact: "test-contact", departmentId: "software", motivation: "这是完整长度的申请理由", consent: "accepted" })
    });
    assert.equal(incomplete.response.status, 400);
    assert.equal(incomplete.body.error, "请检查：班级至少填写 2 个字符");
    assert.deepEqual(incomplete.body.validationErrors, ["班级至少填写 2 个字符"]);
  }

  const multipleInvalidFields = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: " ", studentId: "123", className: "1", contact: "12", motivation: "太短", consent: "accepted" })
  });
  assert.equal(multipleInvalidFields.response.status, 400);
  assert.deepEqual(multipleInvalidFields.body.validationErrors, [
    "姓名至少填写 2 个字符",
    "学号至少填写 4 个字符",
    "班级至少填写 2 个字符",
    "联系方式至少填写 3 个字符",
    "请选择当前开放的部门",
    "申请理由至少填写 10 个字符"
  ]);

  const missingConsent = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试成员", studentId: "20260001", className: "计算机 2601 班", contact: "test-contact", departmentId: "software", motivation: "这是完整长度的申请理由" })
  });
  assert.equal(missingConsent.response.status, 400);
  assert.deepEqual(missingConsent.body.validationErrors, ["请确认同意招新信息使用说明"]);

  const submitted = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试成员", studentId: "20260001", className: "计算机 2601 班", contact: "test-contact", email: "student@example.com", departmentId: "software", motivation: "这是完整长度的申请理由", consent: "accepted" })
  });
  assert.equal(submitted.response.status, 201);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repeated = await request("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "测试成员", studentId: "20260001", className: "计算机 2601 班", contact: "test-contact", departmentId: "software", motivation: `重复提交测试理由 ${attempt}`, consent: "accepted" })
    });
    assert.equal(repeated.response.status, 201);
  }
  const limited = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试成员", studentId: "20260001", className: "计算机 2601 班", contact: "test-contact", departmentId: "software", motivation: "第四次重复提交应被限制", consent: "accepted" })
  });
  assert.equal(limited.response.status, 429);
  const firstRetryAfter = Number(limited.response.headers.get("retry-after"));
  const retriedLimit = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试成员", studentId: "20260001", className: "计算机 2601 班", contact: "test-contact", departmentId: "software", motivation: "限流后重试不应延长等待时间", consent: "accepted" })
  });
  assert.equal(retriedLimit.response.status, 429);
  assert.ok(Number(retriedLimit.response.headers.get("retry-after")) <= firstRetryAfter);

  for (let applicant = 2; applicant <= 7; applicant += 1) {
    const sharedNetwork = await request("/api/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `共享网络成员 ${applicant}`, studentId: `2026000${applicant}`, className: "计算机 2601 班", contact: `contact-${applicant}`, departmentId: "software", motivation: "共享出口网络不应互相占用申请人额度", consent: "accepted" })
    });
    assert.equal(sharedNetwork.response.status, 201);
  }

  const login = await request("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: adminPassword })
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.getSetCookie()[0].split(";", 1)[0];
  const headers = { cookie, "content-type": "application/json", "x-csrf-token": login.body.csrf };

  const applications = await request("/api/admin/applications", { headers: { cookie } });
  const application = applications.body.find((item) => item.id === submitted.body.id);
  assert.equal(application.studentId, "20260001");
  assert.equal(application.className, "计算机 2601 班");
  const approvedApplication = await request(`/api/admin/applications/${application.id}`, { method: "PATCH", headers, body: JSON.stringify({ status: "accepted", reviewNote: "资料审核通过" }) });
  assert.equal(approvedApplication.response.status, 200);

  const promote = () => request(`/api/admin/applications/${application.id}/promote`, {
    method: "POST",
    headers,
    body: JSON.stringify({ permissions: [] })
  });
  const promotionResults = await Promise.all([promote(), promote()]);
  assert.deepEqual(promotionResults.map((result) => result.response.status).sort(), [201, 409]);
  const promoted = promotionResults.find((result) => result.response.status === 201);
  assert.equal(promoted.body.member.studentId, "20260001");
  assert.equal(promoted.body.member.className, "计算机 2601 班");
  assert.equal(promoted.body.member.username, "S20260001");
  assert.equal(promoted.body.member.mustChangePassword, true);
  const activationFile = await fs.readFile(`${dataDirectory}/member-activation-codes.json`, "utf8");
  assert.equal(activationFile.includes(promoted.body.activationCode), false, "raw activation code was persisted");
  const activationRecords = JSON.parse(activationFile);
  activationRecords.find((record) => record.memberId === promoted.body.member.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(`${dataDirectory}/member-activation-codes.json`, `${JSON.stringify(activationRecords, null, 2)}\n`);
  const expiredActivation = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: promoted.body.member.username, activationCode: promoted.body.activationCode, nextPassword: "activated-member-password" }) });
  assert.equal(expiredActivation.response.status, 400);
  const reissued = await request(`/api/admin/members/${promoted.body.member.id}/activation-code`, { method: "POST", headers, body: "{}" });
  assert.equal(reissued.response.status, 200);
  assert.notEqual(reissued.body.activationCode, promoted.body.activationCode);
  const staleActivation = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: promoted.body.member.username, activationCode: promoted.body.activationCode, nextPassword: "activated-member-password" }) });
  assert.equal(staleActivation.response.status, 400);
  const activated = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: promoted.body.member.username, activationCode: reissued.body.activationCode, nextPassword: "activated-member-password" }) });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.response.headers.get("set-cookie"), null, "activation must not create a member session");
  const replayedActivation = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: promoted.body.member.username, activationCode: reissued.body.activationCode, nextPassword: "activated-member-password" }) });
  assert.equal(replayedActivation.response.status, 400);

  console.log(JSON.stringify({ ok: true, invalidRequestsNotCounted: true, applicantLimitApplied: true, retryDidNotExtendLimit: true, sharedNetworkAllowed: true, studentIdPreserved: true, classNamePreserved: true, oneTimeActivationEnforced: true, activationExpiryEnforced: true }));
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const serverExited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await serverExited;
  }
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
