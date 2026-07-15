import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3103";
const dataDirectory = "/tmp/tech-club-member-visibility-test";
const adminPassword = "isolated-admin-password";
const memberPassword = "isolated-member-password";
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

await fs.rm(dataDirectory, { recursive: true, force: true });
const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: "3103", DATA_DIR: dataDirectory, ADMIN_PASSWORD: adminPassword, SESSION_SECRET: "isolated-member-visibility-secret", COOKIE_SECURE: "false" },
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

async function loginMember(username) {
  const login = await request("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: memberPassword }) });
  assert.equal(login.response.status, 200);
  return login.response.headers.getSetCookie()[0].split(";", 1)[0];
}

try {
  await waitForServer();
  const login = await request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: adminPassword }) });
  assert.equal(login.response.status, 200);
  const adminCookie = login.response.headers.getSetCookie()[0].split(";", 1)[0];
  const adminHeaders = { cookie: adminCookie, "content-type": "application/json", "x-csrf-token": login.body.csrf };

  const material = await request("/api/admin/inventory", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "权限测试材料", unit: "件", quantity: 5 }) });
  const fund = await request("/api/admin/funds", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "权限测试资金", balance: 500, currency: "CNY" }) });
  assert.equal(material.response.status, 201);
  assert.equal(fund.response.status, 201);

  for (const member of [
    { username: "public-member", permissions: [] },
    { username: "material-member", permissions: ["resource.basic", "material.request"] }
  ]) {
    const created = await request("/api/admin/members", { method: "POST", headers: adminHeaders, body: JSON.stringify({ ...member, password: memberPassword, name: member.username }) });
    assert.equal(created.response.status, 201);
  }

  const publicCookie = await loginMember("public-member");
  const publicResources = await request("/api/member/resources", { headers: { cookie: publicCookie } });
  assert.deepEqual(publicResources.body.map((resource) => resource.id), ["source-index"]);
  const publicManagement = await request("/api/member/resource-management", { headers: { cookie: publicCookie } });
  assert.deepEqual(publicManagement.body.inventory, []);
  assert.deepEqual(publicManagement.body.funds, []);
  assert.equal(publicManagement.body.capabilities.materialRequests, false);
  assert.equal(publicManagement.body.capabilities.fundRequests, false);
  const guessedProtected = await request("/api/member/resources/starter-kit", { headers: { cookie: publicCookie } });
  assert.equal(guessedProtected.response.status, 403);
  const forgedMaterialRequest = await request("/api/member/usage-requests", { method: "POST", headers: { cookie: publicCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 1, purpose: "伪造无权限材料申请" }) });
  assert.equal(forgedMaterialRequest.response.status, 403);

  const materialCookie = await loginMember("material-member");
  const materialResources = await request("/api/member/resources", { headers: { cookie: materialCookie } });
  assert.deepEqual(materialResources.body.map((resource) => resource.id).sort(), ["source-index", "starter-kit"]);
  const materialManagement = await request("/api/member/resource-management", { headers: { cookie: materialCookie } });
  assert.equal(materialManagement.body.inventory.length, 1);
  assert.deepEqual(materialManagement.body.funds, []);
  assert.equal(materialManagement.body.capabilities.materialRequests, true);
  assert.equal(materialManagement.body.capabilities.fundRequests, false);

  console.log(JSON.stringify({ ok: true, unauthorizedResourcesHidden: true, unauthorizedModulesHidden: true, forgedRequestRejected: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
