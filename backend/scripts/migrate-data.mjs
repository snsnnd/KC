import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = process.env.DATA_DIR || path.join(backendDirectory, "data");

async function readJson(name) {
  return JSON.parse(await fs.readFile(path.join(dataDirectory, name), "utf8"));
}

async function writeJson(name, value) {
  const target = path.join(dataDirectory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
}

let changedProjects = 0;
const content = await readJson("content.json");
content.projects = (content.projects || []).map((project) => {
  if (project.category) return project;
  changedProjects += 1;
  return { ...project, category: project.tags?.[0] || "未分类" };
});
if (changedProjects) {
  content._meta = {
    ...(content._meta || {}),
    revision: Number(content._meta?.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: { username: "system-migration", displayName: "系统迁移" }
  };
  await writeJson("content.json", content);
}

let changedApplications = 0;
const applications = (await readJson("applications.json")).map((application) => {
  if (application.studentId !== undefined && application.className !== undefined) return application;
  changedApplications += 1;
  return { ...application, studentId: application.studentId || "", className: application.className || "" };
});
if (changedApplications) await writeJson("applications.json", applications);

let changedMembers = 0;
const members = (await readJson("members.json")).map((member) => {
  if (member.studentId !== undefined && member.className !== undefined) return member;
  changedMembers += 1;
  return { ...member, studentId: member.studentId || "", className: member.className || "" };
});
if (changedMembers) await writeJson("members.json", members);

let changedAdmins = 0;
const allDepartmentIds = content.departments.map((department) => department.id);
const legacyPanels = {
  editor: ["settings", "projects", "departments", "resources", "applications", "notifications", "uploads", "members", "audit", "inventory", "funds", "usage"],
  reviewer: ["applications", "members", "audit", "inventory", "funds", "usage"]
};
const admins = (await readJson("admins.json")).map((admin) => {
  if (Array.isArray(admin.panelPermissions) && Array.isArray(admin.departmentIds)) return admin;
  changedAdmins += 1;
  return { ...admin, panelPermissions: admin.role === "owner" ? [] : (legacyPanels[admin.role] || []), departmentIds: admin.role === "owner" ? [] : allDepartmentIds };
});
if (changedAdmins) await writeJson("admins.json", admins);

console.log(JSON.stringify({ ok: true, changedProjects, changedApplications, changedMembers, changedAdmins }));
