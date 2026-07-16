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
      name: "资源审批测试成员",
      studentId: "20261001",
      departmentId: "software",
      permissions: ["material.request", "fund.request"]
    })
  });
  assert.equal(member.response.status, 201);

  const preActivationLogin = await jsonRequest("/api/member/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: member.body.member.username, password: memberPassword })
  });
  assert.equal(preActivationLogin.response.status, 403);
  const activation = await jsonRequest("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: member.body.member.username, activationCode: member.body.activationCode, nextPassword: memberPassword }) });
  assert.equal(activation.response.status, 200);
  const memberLogin = await jsonRequest("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: member.body.member.username, password: memberPassword }) });
  assert.equal(memberLogin.response.status, 200);
  const memberCookie = memberLogin.response.headers.getSetCookie()[0].split(";", 1)[0];
  const memberHeaders = { cookie: memberCookie, "content-type": "application/json", "x-csrf-token": memberLogin.body.csrf };
  assert.equal(memberLogin.body.member.mustChangePassword, false);

  const question = await jsonRequest("/api/member/messages", { method: "POST", headers: memberHeaders, body: JSON.stringify({ subject: "测试问询", message: "请管理员回复这条测试问题" }) });
  assert.equal(question.response.status, 201);
  const adminMessages = await jsonRequest("/api/admin/member-messages", { headers: { cookie: adminCookie } });
  assert.ok(adminMessages.body.some((thread) => thread.id === question.body.thread.id));
  const reply = await jsonRequest(`/api/admin/member-messages/${question.body.thread.id}/replies`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ message: "管理员测试回复", close: true }) });
  assert.equal(reply.response.status, 200);
  const memberMessages = await jsonRequest("/api/member/messages", { headers: { cookie: memberCookie } });
  const repliedThread = memberMessages.body.find((thread) => thread.id === question.body.thread.id);
  assert.equal(repliedThread.status, "closed");
  assert.equal(repliedThread.replies[0].message, "管理员测试回复");
  const closedReply = await jsonRequest(`/api/admin/member-messages/${question.body.thread.id}/replies`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ message: "不应写入的追加回复" }) });
  assert.equal(closedReply.response.status, 409);
  const memberFollowUp = await jsonRequest(`/api/member/messages/${question.body.thread.id}/replies`, { method: "POST", headers: memberHeaders, body: JSON.stringify({ message: "成员继续补充并重新打开问询" }) });
  assert.equal(memberFollowUp.response.status, 200);
  assert.equal(memberFollowUp.body.thread.status, "open");
  const followUpReply = await jsonRequest(`/api/admin/member-messages/${question.body.thread.id}/replies`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ message: "管理员继续回复" }) });
  assert.equal(followUpReply.response.status, 200);
  assert.equal(followUpReply.body.thread.replies.at(-1).message, "管理员继续回复");

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

  const archivedFund = await jsonRequest(`/api/admin/funds/${fund.body.account.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "archived" }) });
  assert.equal(archivedFund.response.status, 200);
  assert.equal(archivedFund.body.account.status, "archived");
  let memberManagement = await jsonRequest("/api/member/resource-management", { headers: { cookie: memberCookie } });
  assert.equal(memberManagement.body.funds.some((account) => account.id === fund.body.account.id), false);
  const reactivatedFund = await jsonRequest(`/api/admin/funds/${fund.body.account.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "active" }) });
  assert.equal(reactivatedFund.response.status, 200);
  memberManagement = await jsonRequest("/api/member/resource-management", { headers: { cookie: memberCookie } });
  assert.equal(memberManagement.body.funds.some((account) => account.id === fund.body.account.id), true);

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

  const blockedDelete = await jsonRequest(`/api/admin/inventory/${material.body.item.id}`, { method: "DELETE", headers: adminHeaders });
  assert.equal(blockedDelete.response.status, 409);
  const disposable = await jsonRequest("/api/admin/inventory", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "待删除测试材料", unit: "件", quantity: 2 }) });
  assert.equal(disposable.response.status, 201);
  const deleted = await jsonRequest(`/api/admin/inventory/${disposable.body.item.id}`, { method: "DELETE", headers: adminHeaders });
  assert.equal(deleted.response.status, 200);
  inventory = await jsonRequest("/api/admin/inventory", { headers: { cookie: adminCookie } });
  assert.equal(inventory.body.items.some((item) => item.id === disposable.body.item.id), false);
  assert.ok(inventory.body.ledger.some((entry) => entry.itemId === disposable.body.item.id && entry.direction === "out" && entry.quantity === 2));

  const pendingFundRequest = await jsonRequest("/api/member/usage-requests", { method: "POST", headers: memberHeaders, body: JSON.stringify({ type: "fund", targetId: fund.body.account.id, amount: 20, purpose: "验证待审批资金阻止删除" }) });
  assert.equal(pendingFundRequest.response.status, 201);
  const blockedFundDelete = await jsonRequest(`/api/admin/funds/${fund.body.account.id}`, { method: "DELETE", headers: adminHeaders });
  assert.equal(blockedFundDelete.response.status, 409);
  const disposableFund = await jsonRequest("/api/admin/funds", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "待删除测试资金", currency: "CNY", balance: 50 }) });
  assert.equal(disposableFund.response.status, 201);
  const deletedFund = await jsonRequest(`/api/admin/funds/${disposableFund.body.account.id}`, { method: "DELETE", headers: adminHeaders });
  assert.equal(deletedFund.response.status, 200);
  funds = await jsonRequest("/api/admin/funds", { headers: { cookie: adminCookie } });
  assert.equal(funds.body.accounts.some((account) => account.id === disposableFund.body.account.id), false);
  assert.ok(funds.body.ledger.some((entry) => entry.accountId === disposableFund.body.account.id && entry.direction === "out" && entry.amount === 50));

  const raceFund = await jsonRequest("/api/admin/funds", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "并发删除测试资金", currency: "CNY", balance: 25 }) });
  assert.equal(raceFund.response.status, 201);
  const [racingRequest, racingDelete] = await Promise.all([
    jsonRequest("/api/member/usage-requests", { method: "POST", headers: memberHeaders, body: JSON.stringify({ type: "fund", targetId: raceFund.body.account.id, amount: 5, purpose: "并发申请与删除原子性验证" }) }),
    jsonRequest(`/api/admin/funds/${raceFund.body.account.id}`, { method: "DELETE", headers: adminHeaders })
  ]);
  assert.ok((racingRequest.response.status === 201 && racingDelete.response.status === 409) || (racingRequest.response.status === 400 && racingDelete.response.status === 200));

  const memberMessageReply = await jsonRequest(`/api/member/messages/${question.body.thread.id}/replies`, { method: "POST", headers: memberHeaders, body: JSON.stringify({ message: "成员二次回复验证完整生命周期" }) });
  assert.equal(memberMessageReply.response.status, 200);
  assert.ok(memberMessageReply.body.thread.replies.length >= 3);
  assert.equal(memberMessageReply.body.thread.replies.at(-1).message, "成员二次回复验证完整生命周期");

  const fundArchiveVisibility = await jsonRequest(`/api/admin/funds/${fund.body.account.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "archived" }) });
  assert.equal(fundArchiveVisibility.response.status, 200);
  const memberFundsAfterArchive = await jsonRequest("/api/member/resource-management", { headers: { cookie: memberCookie } });
  assert.equal(memberFundsAfterArchive.body.funds.some((account) => account.id === fund.body.account.id), false);
  await jsonRequest(`/api/admin/funds/${fund.body.account.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "active" }) });

  const reactivation = await jsonRequest(`/api/admin/members/${member.body.member.id}/activation-code`, { method: "POST", headers: adminHeaders, body: "{}" });
  assert.equal(reactivation.response.status, 409, "已激活成员不应重签激活码");

  const bugReport = await jsonRequest("/api/bug-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "测试 Bug", description: "这是一条来自自动化测试的 Bug 反馈", contact: "test@example.com" }) });
  assert.equal(bugReport.response.status, 201);
  const duplicateBugReport = await jsonRequest("/api/bug-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "空", description: "短" }) });
  assert.equal(duplicateBugReport.response.status, 400);
  const bugReports = await jsonRequest("/api/admin/bug-reports", { headers: { cookie: adminCookie } });
  assert.ok(bugReports.body.some((report) => report.id === bugReport.body.report.id));
  const resolveBug = await jsonRequest(`/api/admin/bug-reports/${bugReport.body.report.id}`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ status: "resolved" }) });
  assert.equal(resolveBug.response.status, 200);
  assert.equal(resolveBug.body.report.status, "resolved");

  console.log(JSON.stringify({
    ok: true,
    pendingDidNotDeduct: true,
    materialQuantity: 7,
    fundBalance: 800,
    concurrentApprovalStatuses: concurrentApprovals.map(({ response }) => response.status).sort(),
    insufficientInventoryStatus: excessiveApproval.response.status,
    pendingDeleteBlocked: true,
    inventoryDeletePreservedLedger: true,
    fundArchiveLifecycle: true,
    fundDeletePreservedLedger: true,
    fundRequestDeleteAtomic: true,
    memberMessageReplyLifecycle: true,
    fundArchiveMemberVisibility: true,
    activationReissueBlocksActivated: true,
    bugReportCrud: true,
    memberAdminMessaging: true
  }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
