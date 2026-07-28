import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = await new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    listener.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const base = `http://127.0.0.1:${port}`;
const dataDirectory = await fs.mkdtemp(path.join(tmpdir(), "tech-club-project-workspace-test-"));
const ownerPassword = "isolated-owner-password";
const memberPassword = "isolated-member-password";
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));

const server = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDirectory,
    ADMIN_PASSWORD: ownerPassword,
    SESSION_SECRET: "isolated-project-workspace-test-secret-at-least-32",
    COOKIE_SECURE: "false"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
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

async function login(path, username, password) {
  const result = await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return { cookie: result.response.headers.getSetCookie()[0].split(";", 1)[0], csrf: result.body.csrf, user: result.body.user || result.body.member };
}

async function stopServer() {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  let timeout;
  await Promise.race([
    exited,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("server did not exit after SIGTERM")), 30_000); })
  ]).finally(() => clearTimeout(timeout));
}

try {
  await waitForServer();
  assert.deepEqual(JSON.parse(await fs.readFile(`${dataDirectory}/project-workspaces.json`, "utf8")), []);

  const owner = await login("/api/admin/login", "admin", ownerPassword);
  const ownerHeaders = { cookie: owner.cookie, "content-type": "application/json", "x-csrf-token": owner.csrf };
  const forgedUpload = new FormData();
  forgedUpload.append("file", new Blob(["not a jpeg"], { type: "image/jpeg" }), "forged.jpg");
  const forgedUploadResult = await request("/api/admin/upload", { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrf }, body: forgedUpload });
  assert.equal(forgedUploadResult.response.status, 400);
  const material = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Workspace Material", unit: "piece", quantity: 20 }) });
  assert.equal(material.response.status, 201);
  const fullyAllocatedMaterial = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Fully Allocated Material", unit: "piece", quantity: 10 }) });
  assert.equal(fullyAllocatedMaterial.response.status, 201);
  const workspaceFund = await request("/api/admin/funds", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Workspace Fund", currency: "CNY", balance: 100 }) });
  assert.equal(workspaceFund.response.status, 201);
  const emptyMaterial = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Empty Material", unit: "piece", quantity: 0, unitCost: 0 }) });
  assert.equal(emptyMaterial.response.status, 201);
  assert.equal(emptyMaterial.body.item.quantity, 0);
  const emptyFund = await request("/api/admin/funds", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Empty Fund", currency: "CNY", balance: 0 }) });
  assert.equal(emptyFund.response.status, 201);
  assert.equal(emptyFund.body.account.balance, 0);

  const createdMembers = [];
  for (const [name, studentId] of [["Project Manager", "20267001"], ["Task Assignee", "20267002"], ["Other Project Member", "20267003"], ["Project Outsider", "20267004"]]) {
    const created = await request("/api/admin/members", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name, studentId, email: `${studentId}@example.com`, departmentId: "software", permissions: ["material.request", "fund.request"] })
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const activated = await request("/api/member/activate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: created.body.member.username, activationCode: created.body.activationCode, nextPassword: memberPassword }) });
    assert.equal(activated.response.status, 200);
    createdMembers.push(created.body.member);
  }

  const [manager, assignee, otherMember, outsider] = createdMembers;
  const managerLogin = await login("/api/member/login", manager.username, memberPassword);
  const assigneeLogin = await login("/api/member/login", assignee.username, memberPassword);
  const otherLogin = await login("/api/member/login", otherMember.username, memberPassword);
  const outsiderLogin = await login("/api/member/login", outsider.username, memberPassword);
  const memberHeaders = (session) => ({ cookie: session.cookie, "content-type": "application/json", "x-csrf-token": session.csrf });

  const createdWorkspace = await request("/api/admin/project-workspaces", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      name: "Robot Workspace",
      description: "Secure collaboration workspace",
      status: "planning",
      projectId: "SYS_001",
      memberIds: [manager.id, assignee.id, otherMember.id],
      managerIds: [manager.id],
      allocations: [
        { id: "CLIENT-ID-MUST-NOT-BE-TRUSTED", type: "material", targetId: material.body.item.id, allocated: 10, note: "Prototype quota" },
        { type: "material", targetId: fullyAllocatedMaterial.body.item.id, allocated: 10, note: "Fully reserved" },
        { type: "fund", targetId: workspaceFund.body.account.id, allocated: 60, note: "Project budget" }
      ],
      tasks: [{ id: "FORGED-TASK" }],
      updates: [{ id: "FORGED-UPDATE" }]
    })
  });
  assert.equal(createdWorkspace.response.status, 201, JSON.stringify(createdWorkspace.body));
  const workspace = createdWorkspace.body.workspace;
  assert.notEqual(workspace.allocations[0].id, "CLIENT-ID-MUST-NOT-BE-TRUSTED");
  assert.equal(workspace.allocations[0].targetName, "Workspace Material");
  assert.deepEqual(workspace.tasks, []);
  assert.deepEqual(workspace.updates, []);
  assert.deepEqual(workspace.deliverables, []);
  assert.equal(workspace.progress, 0);
  assert.equal(createdWorkspace.body.leadNotification.recipientCount, 1, "only project leaders should be selected for initial notification");
  assert.equal(workspace.revision, 1);
  const adminManualProgress = await request("/api/admin/project-workspaces", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Manual Progress Workspace", status: "planning", progress: 50, memberIds: [outsider.id], managerIds: [outsider.id] }) });
  assert.equal(adminManualProgress.response.status, 400);
  const overAllocatedWorkspace = await request("/api/admin/project-workspaces", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ name: "Overallocated Workspace", status: "planning", memberIds: [outsider.id], managerIds: [outsider.id], allocations: [{ type: "material", targetId: material.body.item.id, allocated: 11 }] })
  });
  assert.equal(overAllocatedWorkspace.response.status, 400);
  const allocatedMaterialDelete = await request(`/api/admin/inventory/${material.body.item.id}`, { method: "DELETE", headers: ownerHeaders });
  assert.equal(allocatedMaterialDelete.response.status, 409);
  const allocatedMaterialArchive = await request(`/api/admin/inventory/${fullyAllocatedMaterial.body.item.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "archived" }) });
  assert.equal(allocatedMaterialArchive.response.status, 409);
  const allocatedFundArchive = await request(`/api/admin/funds/${workspaceFund.body.account.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "archived" }) });
  assert.equal(allocatedFundArchive.response.status, 409);

  const projectsManager = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ memberId: manager.id, role: "editor", panelPermissions: ["projects"], departmentIds: ["software"] }) });
  assert.equal(projectsManager.response.status, 201);
  const workspacesManager = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ memberId: outsider.id, role: "editor", panelPermissions: ["project-workspaces"], departmentIds: ["software"] }) });
  assert.equal(workspacesManager.response.status, 201);
  const projectsAdmin = await login("/api/admin/login", manager.username, memberPassword);
  const workspacesAdmin = await login("/api/admin/login", outsider.username, memberPassword);
  const projectsOnlyWorkspace = await request("/api/admin/project-workspaces", { headers: { cookie: projectsAdmin.cookie } });
  assert.equal(projectsOnlyWorkspace.response.status, 403);
  const workspacesOnlyWorkspace = await request("/api/admin/project-workspaces", { headers: { cookie: workspacesAdmin.cookie } });
  assert.equal(workspacesOnlyWorkspace.response.status, 200);
  const ownerContent = await request("/api/admin/content", { headers: { cookie: owner.cookie } });
  const workspacesOnlyContentUpdate = await request("/api/admin/content", { method: "PUT", headers: { cookie: workspacesAdmin.cookie, "content-type": "application/json", "x-csrf-token": workspacesAdmin.csrf }, body: JSON.stringify(ownerContent.body) });
  assert.equal(workspacesOnlyContentUpdate.response.status, 403);
  const removeReferencedProject = await request("/api/admin/content", { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ ...ownerContent.body, projects: ownerContent.body.projects.filter((project) => project.id !== "SYS_001") }) });
  assert.equal(removeReferencedProject.response.status, 409);
  const removeReferencedDepartment = await request("/api/admin/content", { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ ...ownerContent.body, departments: ownerContent.body.departments.filter((department) => department.id !== "software") }) });
  assert.equal(removeReferencedDepartment.response.status, 409);
  const referencedMemberDelete = await request(`/api/admin/members/${otherMember.id}`, { method: "DELETE", headers: ownerHeaders });
  assert.equal(referencedMemberDelete.response.status, 409);

  for (const session of [managerLogin, assigneeLogin, otherLogin]) {
    const visible = await request("/api/member/project-workspaces", { headers: { cookie: session.cookie } });
    assert.deepEqual(visible.body.map((item) => item.id), [workspace.id]);
    assert.ok(visible.body[0].members.every((member) => member.email === undefined && member.passwordHash === undefined && member.studentId === undefined));
  }
  const hidden = await request("/api/member/project-workspaces", { headers: { cookie: outsiderLogin.cookie } });
  assert.deepEqual(hidden.body, []);
  const unlinkedAvailability = await request("/api/member/resource-management", { headers: { cookie: outsiderLogin.cookie } });
  assert.equal(unlinkedAvailability.body.inventory.find((item) => item.id === fullyAllocatedMaterial.body.item.id).unlinkedAvailable, 0);
  assert.equal(unlinkedAvailability.body.inventory.find((item) => item.id === material.body.item.id).unlinkedAvailable, 10);
  assert.equal(unlinkedAvailability.body.funds.find((account) => account.id === workspaceFund.body.account.id).unlinkedAvailable, 40);

  const fullyReservedUnlinked = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ type: "material", targetId: fullyAllocatedMaterial.body.item.id, quantity: 1, purpose: "Must not consume project reserve" }) });
  assert.equal(fullyReservedUnlinked.response.status, 409);
  const excessiveUnlinked = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 11, purpose: "Exceeds unallocated inventory" }) });
  assert.equal(excessiveUnlinked.response.status, 409);
  const allowedUnlinked = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 10, purpose: "Uses only unallocated inventory" }) });
  assert.equal(allowedUnlinked.response.status, 201);
  const secondUnlinked = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 1, purpose: "Pending request already holds capacity" }) });
  assert.equal(secondUnlinked.response.status, 409);
  const allocationAgainstPending = await request("/api/admin/project-workspaces", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Pending collision workspace", status: "planning", memberIds: [outsider.id], managerIds: [outsider.id], allocations: [{ type: "material", targetId: material.body.item.id, allocated: 1 }] }) });
  assert.equal(allocationAgainstPending.response.status, 400);
  const cancelledUnlinked = await request(`/api/member/usage-requests/${allowedUnlinked.body.request.id}`, { method: "DELETE", headers: memberHeaders(outsiderLogin) });
  assert.equal(cancelledUnlinked.response.status, 200);
  const excessiveFund = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ type: "fund", targetId: workspaceFund.body.account.id, amount: 41, purpose: "Exceeds unallocated project funds" }) });
  assert.equal(excessiveFund.response.status, 409);
  const allowedFund = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ type: "fund", targetId: workspaceFund.body.account.id, amount: 40, purpose: "Uses unallocated project funds" }) });
  assert.equal(allowedFund.response.status, 201);
  await request(`/api/member/usage-requests/${allowedFund.body.request.id}`, { method: "DELETE", headers: memberHeaders(outsiderLogin) });
  const linkedReserved = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ type: "material", targetId: fullyAllocatedMaterial.body.item.id, quantity: 1, purpose: "Uses assigned project reserve", projectWorkspaceId: workspace.id }) });
  assert.equal(linkedReserved.response.status, 201);
  await request(`/api/member/usage-requests/${linkedReserved.body.request.id}`, { method: "DELETE", headers: memberHeaders(assigneeLogin) });

  const task = await request(`/api/member/project-workspaces/${workspace.id}/tasks`, {
    method: "POST",
    headers: memberHeaders(managerLogin),
    body: JSON.stringify({ title: "Build chassis", description: "Assemble the first prototype", assigneeIds: [assignee.id], dueDate: "2026-12-31" })
  });
  assert.equal(task.response.status, 201, JSON.stringify(task.body));
  assert.equal(task.body.task.status, "todo");
  assert.equal(task.body.assignmentNotification.recipientCount, 1, "only assigned task members should be selected for notification");
  assert.equal(task.body.workspace.progress, 0);
  assert.equal(task.body.workspace.revision, 2);
  const forbiddenTaskEdit = await request(`/api/member/project-workspaces/${workspace.id}/tasks/${task.body.task.id}`, { method: "PATCH", headers: memberHeaders(otherLogin), body: JSON.stringify({ status: "done" }) });
  assert.equal(forbiddenTaskEdit.response.status, 403);
  const assigneeTaskEdit = await request(`/api/member/project-workspaces/${workspace.id}/tasks/${task.body.task.id}`, { method: "PATCH", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ revision: task.body.workspace.revision, status: "in_progress" }) });
  assert.equal(assigneeTaskEdit.response.status, 200);
  assert.equal(assigneeTaskEdit.body.workspace.revision, 3);
  assert.equal(assigneeTaskEdit.body.workspace.progress, 0);
  const staleManagerTaskEdit = await request(`/api/member/project-workspaces/${workspace.id}/tasks/${task.body.task.id}`, { method: "PATCH", headers: memberHeaders(managerLogin), body: JSON.stringify({ revision: task.body.workspace.revision, description: "Stale manager edit" }) });
  assert.equal(staleManagerTaskEdit.response.status, 409);
  assert.equal(staleManagerTaskEdit.body.latestRevision, 3);
  const staleManagerTaskDelete = await request(`/api/member/project-workspaces/${workspace.id}/tasks/${task.body.task.id}`, { method: "DELETE", headers: memberHeaders(managerLogin), body: JSON.stringify({ revision: task.body.workspace.revision }) });
  assert.equal(staleManagerTaskDelete.response.status, 409);
  assert.equal(staleManagerTaskDelete.body.latestRevision, 3);
  let memberRemovalWorkspace = await request("/api/admin/project-workspaces", { headers: { cookie: owner.cookie } });
  memberRemovalWorkspace = memberRemovalWorkspace.body.find((item) => item.id === workspace.id);
  const removeAssignedMember = await request(`/api/admin/project-workspaces/${workspace.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ revision: memberRemovalWorkspace.revision, memberIds: [manager.id, otherMember.id], managerIds: [manager.id] }) });
  assert.equal(removeAssignedMember.response.status, 400);

  const memberUpdate = await request(`/api/member/project-workspaces/${workspace.id}/updates`, { method: "POST", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ message: "Prototype assembly started" }) });
  assert.equal(memberUpdate.response.status, 201);
  assert.equal(memberUpdate.body.workspace.revision, 4);
  const forbiddenProgress = await request(`/api/member/project-workspaces/${workspace.id}/updates`, { method: "POST", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ message: "Forged progress", progress: 80 }) });
  assert.equal(forbiddenProgress.response.status, 400);
  const managerProgress = await request(`/api/member/project-workspaces/${workspace.id}/updates`, { method: "POST", headers: memberHeaders(managerLogin), body: JSON.stringify({ message: "Milestone reviewed", progress: 40 }) });
  assert.equal(managerProgress.response.status, 400);
  const completedTask = await request(`/api/member/project-workspaces/${workspace.id}/tasks/${task.body.task.id}`, { method: "PATCH", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ revision: memberUpdate.body.workspace.revision, status: "done" }) });
  assert.equal(completedTask.response.status, 200);
  assert.equal(completedTask.body.workspace.progress, 100);
  assert.equal(completedTask.body.workspace.taskStats.done, 1);
  assert.equal(completedTask.body.workspace.revision, 5);
  const editorReservationRelease = await request(`/api/admin/project-workspaces/${workspace.id}`, { method: "PATCH", headers: { cookie: workspacesAdmin.cookie, "content-type": "application/json", "x-csrf-token": workspacesAdmin.csrf }, body: JSON.stringify({ revision: completedTask.body.workspace.revision, status: "paused" }) });
  assert.equal(editorReservationRelease.response.status, 403);

  const deliverable = await request(`/api/member/project-workspaces/${workspace.id}/deliverables`, { method: "POST", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ title: "Robot documentation", type: "document", url: "https://example.com/robot-docs", description: "Assembly guide and completed prototype notes" }) });
  assert.equal(deliverable.response.status, 201, JSON.stringify(deliverable.body));
  assert.equal(deliverable.body.workspace.deliverables.length, 1);
  const outsiderDeliverable = await request(`/api/member/project-workspaces/${workspace.id}/deliverables`, { method: "POST", headers: memberHeaders(outsiderLogin), body: JSON.stringify({ title: "Forged deliverable", type: "website", url: "https://example.com/forged" }) });
  assert.equal(outsiderDeliverable.response.status, 404);
  const archiveWithoutResources = await request(`/api/admin/project-workspaces/${workspace.id}/deliverables/${deliverable.body.deliverable.id}/archive`, { method: "POST", headers: { cookie: workspacesAdmin.cookie, "content-type": "application/json", "x-csrf-token": workspacesAdmin.csrf }, body: JSON.stringify({ permissionKey: "project.robot" }) });
  assert.equal(archiveWithoutResources.response.status, 403);
  const archivedDeliverable = await request(`/api/admin/project-workspaces/${workspace.id}/deliverables/${deliverable.body.deliverable.id}/archive`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ permissionKey: "project.robot" }) });
  assert.equal(archivedDeliverable.response.status, 200, JSON.stringify(archivedDeliverable.body));
  assert.equal(archivedDeliverable.body.resource.permissionKey, "project.robot");
  assert.equal(archivedDeliverable.body.resource.url, "https://example.com/robot-docs");
  assert.ok(archivedDeliverable.body.resources.some((resource) => resource.id === archivedDeliverable.body.resource.id));
  const archiveUpdate = archivedDeliverable.body.workspace.updates.find((update) => update.type === "deliverable_archived");
  assert.deepEqual(Object.keys(archiveUpdate.actor).sort(), ["displayName", "id"]);
  const contentAfterArchive = await request("/api/admin/content", { headers: { cookie: owner.cookie } });
  assert.ok(contentAfterArchive.body.resources.some((resource) => resource.id === archivedDeliverable.body.resource.id));
  const deleteArchivedDeliverable = await request(`/api/member/project-workspaces/${workspace.id}/deliverables/${deliverable.body.deliverable.id}`, { method: "DELETE", headers: memberHeaders(assigneeLogin), body: "{}" });
  assert.equal(deleteArchivedDeliverable.response.status, 409);

  const linkedRequest = await request("/api/member/usage-requests", {
    method: "POST",
    headers: memberHeaders(assigneeLogin),
    body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 4, purpose: "Build project prototype", projectWorkspaceId: workspace.id })
  });
  assert.equal(linkedRequest.response.status, 201, JSON.stringify(linkedRequest.body));
  assert.equal(linkedRequest.body.request.projectWorkspaceName, "Robot Workspace");
  const overQuota = await request("/api/member/usage-requests", {
    method: "POST",
    headers: memberHeaders(assigneeLogin),
    body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 7, purpose: "Exceed project quota", projectWorkspaceId: workspace.id })
  });
  assert.equal(overQuota.response.status, 400);
  let adminWorkspaceState = await request("/api/admin/project-workspaces", { headers: { cookie: owner.cookie } });
  let currentAdminWorkspace = adminWorkspaceState.body.find((item) => item.id === workspace.id);
  const removeUsedAllocation = await request(`/api/admin/project-workspaces/${workspace.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ revision: currentAdminWorkspace.revision, allocations: currentAdminWorkspace.allocations.filter((item) => item.targetId !== material.body.item.id) })
  });
  assert.equal(removeUsedAllocation.response.status, 409);

  const reviewer = await request("/api/admin/managers", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ memberId: assignee.id, role: "reviewer", panelPermissions: ["usage", "project-workspaces"], departmentIds: ["software"] }) });
  assert.equal(reviewer.response.status, 201, JSON.stringify(reviewer.body));
  const selfReviewer = await login("/api/admin/login", assignee.username, memberPassword);
  const reviewerWorkspaceOptions = await request("/api/admin/project-workspaces?options=1", { headers: { cookie: selfReviewer.cookie } });
  assert.deepEqual(reviewerWorkspaceOptions.body.members, []);
  assert.deepEqual(reviewerWorkspaceOptions.body.inventory.items, []);
  const selfApproval = await request(`/api/admin/usage-requests/${linkedRequest.body.request.id}`, { method: "PATCH", headers: { cookie: selfReviewer.cookie, "content-type": "application/json", "x-csrf-token": selfReviewer.csrf }, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(selfApproval.response.status, 403);

  const approved = await request(`/api/admin/usage-requests/${linkedRequest.body.request.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ decision: "approved", reviewNote: "Approved by owner" }) });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  let workspaceState = await request("/api/member/project-workspaces", { headers: { cookie: managerLogin.cookie } });
  let allocation = workspaceState.body[0].allocations[0];
  assert.equal(allocation.used, 4);
  assert.equal(allocation.pending, 0);
  assert.equal(allocation.remaining, 6);

  adminWorkspaceState = await request("/api/admin/project-workspaces", { headers: { cookie: owner.cookie } });
  currentAdminWorkspace = adminWorkspaceState.body.find((item) => item.id === workspace.id);
  const removeUnusedAllocations = await request(`/api/admin/project-workspaces/${workspace.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ revision: currentAdminWorkspace.revision, allocations: currentAdminWorkspace.allocations.filter((item) => item.targetId === material.body.item.id) })
  });
  assert.equal(removeUnusedAllocations.response.status, 200, JSON.stringify(removeUnusedAllocations.body));
  assert.equal(removeUnusedAllocations.body.workspace.revision, currentAdminWorkspace.revision + 1);
  const staleRevision = await request(`/api/admin/project-workspaces/${workspace.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ revision: currentAdminWorkspace.revision, name: "Stale update" }) });
  assert.equal(staleRevision.response.status, 409);

  const staleMemberRequest = await request("/api/member/usage-requests", {
    method: "POST",
    headers: memberHeaders(otherLogin),
    body: JSON.stringify({ type: "material", targetId: material.body.item.id, quantity: 2, purpose: "Request before suspension", projectWorkspaceId: workspace.id })
  });
  assert.equal(staleMemberRequest.response.status, 201);
  const suspended = await request(`/api/admin/members/${otherMember.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "suspended" }) });
  assert.equal(suspended.response.status, 200);
  const staleApproval = await request(`/api/admin/usage-requests/${staleMemberRequest.body.request.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(staleApproval.response.status, 409);

  const history = await request("/api/member/resource-management", { headers: { cookie: assigneeLogin.cookie } });
  assert.equal(history.body.requests.find((item) => item.id === linkedRequest.body.request.id).projectWorkspaceName, "Robot Workspace");
  workspaceState = await request("/api/member/project-workspaces", { headers: { cookie: managerLogin.cookie } });
  allocation = workspaceState.body[0].allocations[0];
  assert.equal(allocation.used, 4);
  assert.equal(allocation.pending, 2);
  assert.equal(allocation.remaining, 4);

  const recoveryMaterial = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Recovery Material", unit: "piece", quantity: 5 }) });
  assert.equal(recoveryMaterial.response.status, 201);
  const recoveryRequest = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ type: "material", targetId: recoveryMaterial.body.item.id, quantity: 1, purpose: "Recover partial approval ledger" }) });
  assert.equal(recoveryRequest.response.status, 201);
  const inventoryPath = path.join(dataDirectory, "inventory.json");
  const ledgerPath = path.join(dataDirectory, "inventory-ledger.json");
  const tokenPath = path.join(dataDirectory, "email-approval-tokens.json");
  const recoveryInventory = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
  recoveryInventory.find((item) => item.id === recoveryMaterial.body.item.id).quantity = 4;
  await fs.writeFile(inventoryPath, `${JSON.stringify(recoveryInventory, null, 2)}\n`);
  const recoveryLedger = JSON.parse(await fs.readFile(ledgerPath, "utf8"));
  const originalActor = { id: "ADM-ORIGINAL", username: "original", displayName: "Original Approver" };
  const originalLedgerAt = new Date(Date.now() - 1000).toISOString();
  recoveryLedger.unshift({ id: "MATLOG-RECOVERY", itemId: recoveryMaterial.body.item.id, itemName: "Recovery Material", direction: "out", quantity: 1, unit: "piece", reason: "Partial approval", requestId: recoveryRequest.body.request.id, memberId: assignee.id, actor: originalActor, createdAt: originalLedgerAt });
  await fs.writeFile(ledgerPath, `${JSON.stringify(recoveryLedger, null, 2)}\n`);
  const recoveryTokens = JSON.parse(await fs.readFile(tokenPath, "utf8"));
  recoveryTokens.push({ id: "TOKEN-RECOVERY", requestId: recoveryRequest.body.request.id, tokenHash: "unused", action: "approved", createdAt: originalLedgerAt });
  await fs.writeFile(tokenPath, `${JSON.stringify(recoveryTokens, null, 2)}\n`);
  const recovered = await request(`/api/admin/usage-requests/${recoveryRequest.body.request.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body));
  assert.equal(recovered.body.recovered, true);
  assert.equal(recovered.body.notified, false);
  assert.equal(recovered.body.request.reviewedBy.id, originalActor.id);
  assert.ok(recovered.body.request.reviewNote);
  const inventoryAfterRecovery = JSON.parse(await fs.readFile(inventoryPath, "utf8"));
  assert.equal(inventoryAfterRecovery.find((item) => item.id === recoveryMaterial.body.item.id).quantity, 4);
  const tokensAfterRecovery = JSON.parse(await fs.readFile(tokenPath, "utf8"));
  assert.ok(tokensAfterRecovery.find((token) => token.id === "TOKEN-RECOVERY").invalidatedAt);
  const recoveryAudit = await request("/api/admin/audit", { headers: { cookie: owner.cookie } });
  assert.ok(recoveryAudit.body.some((entry) => entry.action === "usage.recovered" && entry.target === recoveryRequest.body.request.id));

  const historyMaterial = await request("/api/admin/inventory", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "History Material", unit: "piece", quantity: 100 }) });
  assert.equal(historyMaterial.response.status, 201);
  const usagePath = path.join(dataDirectory, "usage-requests.json");
  const usageBeforeFixture = JSON.parse(await fs.readFile(usagePath, "utf8"));
  const fixtureHistory = Array.from({ length: 5000 }, (_, index) => ({ id: `HISTORY-${index}`, type: "material", memberId: "HISTORICAL-MEMBER", targetId: "HISTORICAL-TARGET", targetName: "Historical", quantity: 1, unit: "piece", purpose: "Historical fixture", status: "rejected", createdAt: originalLedgerAt }));
  await fs.writeFile(usagePath, `${JSON.stringify([...usageBeforeFixture, ...fixtureHistory], null, 2)}\n`);
  const historyRequest = await request("/api/member/usage-requests", { method: "POST", headers: memberHeaders(assigneeLogin), body: JSON.stringify({ type: "material", targetId: historyMaterial.body.item.id, quantity: 1, purpose: "Verify complete usage history retention" }) });
  assert.equal(historyRequest.response.status, 201);
  const usageAfterFixture = JSON.parse(await fs.readFile(usagePath, "utf8"));
  assert.equal(usageAfterFixture.length, usageBeforeFixture.length + fixtureHistory.length + 1);
  assert.ok(usageAfterFixture.some((item) => item.id === "HISTORY-4999"));

  const bug = await request("/api/bug-report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Workspace bug", description: "Project workspace test bug report" }) });
  assert.equal(bug.response.status, 201);
  const memberCannotReadBugs = await request("/api/admin/bug-reports", { headers: { cookie: assigneeLogin.cookie } });
  assert.equal(memberCannotReadBugs.response.status, 401);
  const reviewerBugs = await request("/api/admin/bug-reports", { headers: { cookie: selfReviewer.cookie } });
  assert.equal(reviewerBugs.response.status, 200);
  const reviewerBugPatch = await request(`/api/admin/bug-reports/${bug.body.report.id}`, { method: "PATCH", headers: { cookie: selfReviewer.cookie, "content-type": "application/json", "x-csrf-token": selfReviewer.csrf }, body: JSON.stringify({ status: "resolved" }) });
  assert.equal(reviewerBugPatch.response.status, 200);

  console.log(JSON.stringify({ ok: true, panelIsolation: true, resourceReservations: true, revisionConflicts: true, referenceIntegrity: true, allocationHistoryProtected: true, workspaceDtoContext: true, taskDrivenProgress: true, targetedProjectNotifications: true, deliverableArchiving: true, usageHistoryPreserved: true, ledgerRecovery: true, gracefulShutdown: true }));
} finally {
  try {
    await stopServer();
  } finally {
    await fs.rm(dataDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
