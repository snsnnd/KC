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
  const incomplete = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试成员", studentId: "20260001", contact: "test-contact", departmentId: "software", motivation: "这是完整长度的申请理由" })
  });
  assert.equal(incomplete.response.status, 400);

  const submitted = await request("/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "测试成员", studentId: "20260001", className: "计算机 2601 班", contact: "test-contact", email: "student@example.com", departmentId: "software", motivation: "这是完整长度的申请理由" })
  });
  assert.equal(submitted.response.status, 201);

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

  const promoted = await request(`/api/admin/applications/${application.id}/promote`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "profile-test", password: "member-test-password", permissions: [] })
  });
  assert.equal(promoted.response.status, 201);
  assert.equal(promoted.body.member.studentId, "20260001");
  assert.equal(promoted.body.member.className, "计算机 2601 班");

  console.log(JSON.stringify({ ok: true, requiredProfileRejected: true, studentIdPreserved: true, classNamePreserved: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
