import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3101";
const dataDirectory = "/tmp/tech-club-resource-test";
const adminPassword = "isolated-admin-password";
const memberPassword = "isolated-member-password";

await fs.rm(dataDirectory, { recursive: true, force: true });
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: "3101",
    DATA_DIR: dataDirectory,
    ADMIN_PASSWORD: adminPassword,
    SESSION_SECRET: "isolated-resource-approval-test-secret",
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

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  return { response, body };
}

try {
  await waitForServer();

  const adminLogin = await jsonRequest("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: adminPassword })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.getSetCookie()[0].split(";", 1)[0];
  const adminHeaders = {
    cookie: adminCookie,
    "content-type": "application/json",
    "x-csrf-token": adminLogin.body.csrf
  };

  const material = await jsonRequest("/api/admin/inventory", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: "隔离测试材料", unit: "件", quantity: 10 })
  });
  assert.equal(material.response.status, 201);

  const fund = await jsonRequest("/api/admin/funds", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ name: "隔离测试资金", currency: "CNY", balance: 1000 })
  });
  assert.equal(fund.response.status, 201);

  const member = await jsonRequest("/api/admin/members", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      username: "resource-test-member",
      password: memberPassword,
      name: "资源审批测试成员",
      permissions: ["material.request", "fund.request"]
    })
  });
  assert.equal(member.response.status, 201);

  const memberLogin = await jsonRequest("/api/member/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "resource-test-member", password: memberPassword })
  });
  assert.equal(memberLogin.response.status, 200);
  const memberCookie = memberLogin.response.headers.getSetCookie()[0].split(";", 1)[0];
  const memberHeaders = { cookie: memberCookie, "content-type": "application/json" };

  const materialRequest = await jsonRequest("/api/member/usage-requests", {
    method: "POST",
    headers: memberHeaders,
    body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 3, purpose: "隔离环境审批验证" })
  });
  assert.equal(materialRequest.response.status, 201);

  const fundRequest = await jsonRequest("/api/member/usage-requests", {
    method: "POST",
    headers: memberHeaders,
    body: JSON.stringify({ type: "fund", targetId: fund.body.account.id, amount: 200, purpose: "隔离环境资金审批验证" })
  });
  assert.equal(fundRequest.response.status, 201);

  let inventory = await jsonRequest("/api/admin/inventory", { headers: { cookie: adminCookie } });
  let funds = await jsonRequest("/api/admin/funds", { headers: { cookie: adminCookie } });
  assert.equal(inventory.body.items.find((item) => item.id === material.body.item.id).quantity, 10, "pending material request changed inventory");
  assert.equal(funds.body.accounts.find((account) => account.id === fund.body.account.id).balance, 1000, "pending fund request changed balance");

  const approveMaterial = () => jsonRequest(`/api/admin/usage-requests/${materialRequest.body.request.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ decision: "approved", reviewNote: "并发审批验证" })
  });
  const concurrentApprovals = await Promise.all([approveMaterial(), approveMaterial()]);
  assert.deepEqual(concurrentApprovals.map(({ response }) => response.status).sort(), [200, 409]);

  const approveFund = await jsonRequest(`/api/admin/usage-requests/${fundRequest.body.request.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ decision: "approved", reviewNote: "资金审批验证" })
  });
  assert.equal(approveFund.response.status, 200);

  inventory = await jsonRequest("/api/admin/inventory", { headers: { cookie: adminCookie } });
  funds = await jsonRequest("/api/admin/funds", { headers: { cookie: adminCookie } });
  assert.equal(inventory.body.items.find((item) => item.id === material.body.item.id).quantity, 7);
  assert.equal(funds.body.accounts.find((account) => account.id === fund.body.account.id).balance, 800);
  assert.equal(inventory.body.ledger.filter((entry) => entry.requestId === materialRequest.body.request.id).length, 1);
  assert.equal(funds.body.ledger.filter((entry) => entry.requestId === fundRequest.body.request.id).length, 1);

  const excessiveRequest = await jsonRequest("/api/member/usage-requests", {
    method: "POST",
    headers: memberHeaders,
    body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 20, purpose: "验证库存不足时拒绝审批" })
  });
  assert.equal(excessiveRequest.response.status, 201);
  const excessiveApproval = await jsonRequest(`/api/admin/usage-requests/${excessiveRequest.body.request.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ decision: "approved", reviewNote: "应因库存不足失败" })
  });
  assert.equal(excessiveApproval.response.status, 409);
  assert.equal(excessiveApproval.body.error, "当前库存不足，无法批准");
  inventory = await jsonRequest("/api/admin/inventory", { headers: { cookie: adminCookie } });
  assert.equal(inventory.body.items.find((item) => item.id === material.body.item.id).quantity, 7);

  console.log(JSON.stringify({
    ok: true,
    pendingDidNotDeduct: true,
    materialQuantity: 7,
    fundBalance: 800,
    concurrentApprovalStatuses: concurrentApprovals.map(({ response }) => response.status).sort(),
    insufficientInventoryStatus: excessiveApproval.response.status
  }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
