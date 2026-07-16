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

async function loginMember(created) {
  const activated = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: created.member.username, activationCode: created.activationCode, nextPassword: memberPassword }) });
  assert.equal(activated.response.status, 200);
  const login = await request("/api/member/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: created.member.username, password: memberPassword }) });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.getSetCookie()[0].split(";", 1)[0];
  return cookie;
}

try {
  await waitForServer();
  const login = await request("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: adminPassword }) });
  assert.equal(login.response.status, 200);
  const adminCookie = login.response.headers.getSetCookie()[0].split(";", 1)[0];
  const adminHeaders = { cookie: adminCookie, "content-type": "application/json", "x-csrf-token": login.body.csrf };

  const adminContent = await request("/api/admin/content", { headers: { cookie: adminCookie } });
  const collection = {
    id: "resource-collection",
    title: "资源大合集",
    description: "包含多个小资源和多个链接",
    type: "COLLECTION",
    url: "https://example.com/collection",
    links: [{ label: "合集说明", url: "https://example.com/collection-guide" }],
    accessNote: "仅授权成员访问",
    permissionKey: "resource.collection",
    accessSecret: "collection-secret",
    children: [{ id: "resource-child", title: "合集子资源", description: "继承合集权限", type: "DOWNLOAD", url: "https://example.com/child", links: [{ label: "镜像地址", url: "https://example.com/child-mirror" }], accessNote: "子资源说明", permissionKey: "", accessSecret: "child-secret", children: [] }]
  };
  const savedContent = await request("/api/admin/content", { method: "PUT", headers: adminHeaders, body: JSON.stringify({ ...adminContent.body, resources: [...adminContent.body.resources, collection] }) });
  assert.equal(savedContent.response.status, 200);
  const concurrentContentSaves = await Promise.all([
    request("/api/admin/content", { method: "PUT", headers: adminHeaders, body: JSON.stringify(savedContent.body.content) }),
    request("/api/admin/content", { method: "PUT", headers: adminHeaders, body: JSON.stringify(savedContent.body.content) })
  ]);
  assert.deepEqual(concurrentContentSaves.map(({ response }) => response.status).sort(), [200, 409]);
  const latestContent = await request("/api/admin/content", { headers: { cookie: adminCookie } });
  const excessiveLinks = structuredClone(latestContent.body);
  excessiveLinks.resources.find((resource) => resource.id === collection.id).links = Array.from({ length: 13 }, (_, index) => ({ label: `链接 ${index + 1}`, url: `https://example.com/link-${index + 1}` }));
  const excessiveLinkSave = await request("/api/admin/content", { method: "PUT", headers: adminHeaders, body: JSON.stringify(excessiveLinks) });
  assert.equal(excessiveLinkSave.response.status, 400);
  const publicContent = await request("/api/content");
  const publicCollection = publicContent.body.resources.find((resource) => resource.id === collection.id);
  assert.equal(publicCollection.protected, true);
  assert.equal(publicCollection.url, "");
  assert.equal(publicCollection.links[0].url, "");
  assert.equal(publicCollection.children[0].protected, true);
  assert.equal(publicCollection.children[0].url, "");

  const material = await request("/api/admin/inventory", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "权限测试材料", unit: "件", quantity: 5 }) });
  const fund = await request("/api/admin/funds", { method: "POST", headers: adminHeaders, body: JSON.stringify({ name: "权限测试资金", balance: 500, currency: "CNY" }) });
  assert.equal(material.response.status, 201);
  assert.equal(fund.response.status, 201);

  const createdMembers = [];
  for (const member of [
    { name: "公开成员", studentId: "20262001", permissions: [] },
    { name: "材料成员", studentId: "20262002", permissions: ["resource.basic", "resource.collection", "material.request"] }
  ]) {
    const created = await request("/api/admin/members", { method: "POST", headers: adminHeaders, body: JSON.stringify({ ...member, departmentId: "software" }) });
    assert.equal(created.response.status, 201);
    createdMembers.push(created.body);
  }

  const publicCookie = await loginMember(createdMembers[0]);
  const publicResources = await request("/api/member/resources", { headers: { cookie: publicCookie } });
  assert.deepEqual(publicResources.body.map((resource) => resource.id), ["source-index"]);
  const publicManagement = await request("/api/member/resource-management", { headers: { cookie: publicCookie } });
  assert.deepEqual(publicManagement.body.inventory, []);
  assert.deepEqual(publicManagement.body.funds, []);
  assert.equal(publicManagement.body.capabilities.materialRequests, false);
  assert.equal(publicManagement.body.capabilities.fundRequests, false);
  const guessedProtected = await request("/api/member/resources/starter-kit", { headers: { cookie: publicCookie } });
  assert.equal(guessedProtected.response.status, 403);
  const guessedProtectedChild = await request("/api/member/resources/resource-child", { headers: { cookie: publicCookie } });
  assert.equal(guessedProtectedChild.response.status, 403);
  const forgedMaterialRequest = await request("/api/member/usage-requests", { method: "POST", headers: { cookie: publicCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 1, purpose: "伪造无权限材料申请" }) });
  assert.equal(forgedMaterialRequest.response.status, 403);

  const materialCookie = await loginMember(createdMembers[1]);
  const materialResources = await request("/api/member/resources", { headers: { cookie: materialCookie } });
  assert.deepEqual(materialResources.body.map((resource) => resource.id).sort(), ["resource-collection", "source-index", "starter-kit"]);
  const memberCollection = materialResources.body.find((resource) => resource.id === "resource-collection");
  assert.deepEqual(memberCollection.children.map((resource) => resource.id), ["resource-child"]);
  const childDetail = await request("/api/member/resources/resource-child", { headers: { cookie: materialCookie } });
  assert.equal(childDetail.response.status, 200);
  assert.equal(childDetail.body.links[0].url, "https://example.com/child-mirror");
  assert.equal(childDetail.body.accessSecret, "child-secret");
  const materialManagement = await request("/api/member/resource-management", { headers: { cookie: materialCookie } });
  assert.equal(materialManagement.body.inventory.length, 1);
  assert.deepEqual(materialManagement.body.funds, []);
  assert.equal(materialManagement.body.capabilities.materialRequests, true);
  assert.equal(materialManagement.body.capabilities.fundRequests, false);

  console.log(JSON.stringify({ ok: true, unauthorizedResourcesHidden: true, unauthorizedModulesHidden: true, forgedRequestRejected: true, resourceCollections: true, nestedPermissionInheritance: true, multipleResourceLinks: true, concurrentContentConflict: true, resourceLimitsRejectWithoutTruncation: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
