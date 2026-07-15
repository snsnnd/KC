import assert from "node:assert/strict";

const base = process.env.BASE_URL || "https://47.120.0.45";
const username = process.env.SMOKE_ADMIN_USERNAME;
const password = process.env.SMOKE_ADMIN_PASSWORD;
assert.ok(username && password, "SMOKE_ADMIN_USERNAME and SMOKE_ADMIN_PASSWORD are required");

async function json(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json();
  assert.ok(response.ok, `${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

const health = await json("/api/health");
assert.equal(health.body.ok, true);

const content = await json("/api/content");
assert.ok(content.body.projects.every((project) => project.category), "a project is missing its category");

for (const path of ["/", "/portal.html", "/email-approval.html", "/admin.html", "/admin.html?workspace=operations", "/admin.html?workspace=people", "/admin.html?workspace=assets", "/join.html", "/member.html", "/assets/css/home.css", "/assets/js/app.js", "/assets/js/portal.js", "/assets/js/email-approval.js"]) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, `${path} did not load`);
}

const login = await json("/api/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password })
});
assert.equal(login.body.user.role, "owner");
assert.ok(login.body.user.panelPermissions.includes("managers"));
const cookie = login.response.headers.getSetCookie()[0].split(";", 1)[0];

const [, , , , mail] = await Promise.all([
  json("/api/admin/content", { headers: { cookie } }),
  json("/api/admin/applications", { headers: { cookie } }),
  json("/api/admin/inventory", { headers: { cookie } }),
  json("/api/admin/funds", { headers: { cookie } }),
  json("/api/admin/mail", { headers: { cookie } })
]);
assert.ok(mail.body.applicationRecipientAdminIds.length > 0);

console.log(JSON.stringify({ ok: true, mail: health.body.mail, projects: content.body.projects.length, adminRole: login.body.user.role }));
