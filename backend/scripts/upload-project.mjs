import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const manifestArgument = process.argv[2];
const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const username = process.env.ADMIN_USERNAME || "";
const password = process.env.ADMIN_PASSWORD || "";

if (!manifestArgument) throw new Error("usage: npm run upload:project -- /path/to/project.json");
if (!baseUrl || !username || !password) throw new Error("BASE_URL, ADMIN_USERNAME and ADMIN_PASSWORD are required");

const origin = new URL(baseUrl).origin;
const manifestPath = path.resolve(manifestArgument);
const manifestDirectory = path.dirname(manifestPath);
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

for (const field of ["id", "title", "category", "description"]) {
  if (!String(manifest[field] || "").trim()) throw new Error(`manifest field is required: ${field}`);
}

const mimeByExtension = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"], [".avif", "image/avif"],
  [".mp4", "video/mp4"], [".webm", "video/webm"]
]);

async function parseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${body.error || JSON.stringify(body)}`);
  return body;
}

const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ username, password })
});
const login = await parseJson(loginResponse);
const setCookie = loginResponse.headers.getSetCookie?.()[0] || loginResponse.headers.get("set-cookie") || "";
const cookie = setCookie.split(";", 1)[0];
if (!cookie) throw new Error("admin login did not return a session cookie");

async function api(url, options = {}) {
  const headers = { cookie, ...(options.headers || {}) };
  if (options.method && options.method !== "GET") {
    headers.origin = origin;
    headers["x-csrf-token"] = login.csrf;
  }
  return parseJson(await fetch(`${baseUrl}${url}`, { ...options, headers }));
}

async function uploadMedia(relativePath) {
  if (!relativePath) return "";
  const filePath = path.resolve(manifestDirectory, relativePath);
  const mime = mimeByExtension.get(path.extname(filePath).toLowerCase());
  if (!mime) throw new Error(`unsupported media type: ${filePath}`);
  const data = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([data], { type: mime }), path.basename(filePath));
  const uploaded = await api("/api/admin/upload", { method: "POST", body: form });
  return uploaded.url;
}

const content = await api("/api/admin/content");
if (!Array.isArray(content.projects)) throw new Error("current administrator cannot read projects");
if (content.projects.length >= 100) throw new Error("project limit reached (100)");
if (manifest.achievement && (content.achievements || []).length >= 100) throw new Error("achievement limit reached (100)");
if (content.projects.some((project) => project.id === manifest.id)) throw new Error(`project id already exists: ${manifest.id}`);
if (manifest.achievement && (content.achievements || []).some((achievement) => achievement.id === (manifest.achievement.id || `${manifest.id}_ACH`))) throw new Error("achievement id already exists");

const [poster, video] = await Promise.all([
  manifest.posterFile ? uploadMedia(manifest.posterFile) : Promise.resolve(manifest.poster || ""),
  manifest.videoFile ? uploadMedia(manifest.videoFile) : Promise.resolve(manifest.video || "")
]);

const project = {
  id: manifest.id,
  title: manifest.title,
  category: manifest.category,
  description: manifest.description,
  tags: Array.isArray(manifest.tags) ? manifest.tags : [],
  color: manifest.color || "#b8ff3d",
  poster,
  video,
  links: Array.isArray(manifest.links) ? manifest.links : []
};
const achievement = manifest.achievement ? {
  id: manifest.achievement.id || `${manifest.id}_ACH`,
  title: manifest.achievement.title || manifest.title,
  type: manifest.achievement.type || "项目成果",
  description: manifest.achievement.description || manifest.description,
  date: manifest.achievement.date || "",
  projectId: manifest.id,
  image: manifest.achievement.image || poster,
  url: manifest.achievement.url || (project.links.find((link) => link.url)?.url || "")
} : null;

const saved = await api("/api/admin/content", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...content, projects: [...content.projects, project], achievements: achievement ? [...(content.achievements || []), achievement] : content.achievements || [] })
});

process.stdout.write(`${JSON.stringify({ ok: true, project: saved.content.projects.find((item) => item.id === project.id), achievement: achievement ? saved.content.achievements.find((item) => item.id === achievement.id) : null }, null, 2)}\n`);
