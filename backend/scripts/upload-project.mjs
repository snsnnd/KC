import fs from "node:fs/promises";
import path from "node:path";

const argumentsList = process.argv.slice(2);
const dryRun = argumentsList.includes("--dry-run");
const manifestArgument = argumentsList.find((argument) => !argument.startsWith("--"));
const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const username = process.env.ADMIN_USERNAME || "";
const password = process.env.ADMIN_PASSWORD || "";

if (!manifestArgument) throw new Error("usage: npm run upload:project -- /path/to/projects.json [--dry-run]");
if (!baseUrl || !username || !password) throw new Error("BASE_URL, ADMIN_USERNAME and ADMIN_PASSWORD are required");

const origin = new URL(baseUrl).origin;
const manifestPath = path.resolve(manifestArgument);
const manifestDirectory = path.dirname(manifestPath);
const manifestDocument = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const manifests = Array.isArray(manifestDocument) ? manifestDocument : Array.isArray(manifestDocument.projects) ? manifestDocument.projects : [manifestDocument];

if (!manifests.length) throw new Error("manifest does not contain any projects");

const mimeByExtension = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"], [".avif", "image/avif"],
  [".mp4", "video/mp4"], [".webm", "video/webm"]
]);
const imageMimes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
const videoMimes = new Set(["video/mp4", "video/webm"]);

function text(value) {
  return String(value || "").trim();
}

function validateUrl(value, field, errors) {
  const url = text(value);
  if (!url) return;
  if (url.startsWith("/uploads/")) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return;
  } catch {}
  errors.push(`${field} must be an http(s) URL or /uploads/ path`);
}

function validateManifest(manifest, index) {
  const prefix = `projects[${index}]`;
  const errors = [];
  for (const field of ["id", "title", "category", "description"]) {
    if (!text(manifest[field])) errors.push(`${prefix}.${field} is required`);
  }
  if (text(manifest.id) && !/^[A-Za-z0-9_-]{2,40}$/.test(text(manifest.id))) errors.push(`${prefix}.id must use 2-40 letters, numbers, underscores or hyphens`);
  if (text(manifest.title).length > 100) errors.push(`${prefix}.title exceeds 100 characters`);
  if (text(manifest.category).length > 40) errors.push(`${prefix}.category exceeds 40 characters`);
  if (text(manifest.description).length > 800) errors.push(`${prefix}.description exceeds 800 characters`);
  if (manifest.color && !/^#[0-9a-f]{6}$/i.test(manifest.color)) errors.push(`${prefix}.color must be a six-digit hex color`);
  if (manifest.tags != null && !Array.isArray(manifest.tags)) errors.push(`${prefix}.tags must be an array`);
  if ((manifest.tags || []).length > 10) errors.push(`${prefix}.tags supports at most 10 entries`);
  (manifest.tags || []).forEach((tag, tagIndex) => { if (text(tag).length > 30) errors.push(`${prefix}.tags[${tagIndex}] exceeds 30 characters`); });
  if (manifest.links != null && !Array.isArray(manifest.links)) errors.push(`${prefix}.links must be an array`);
  if ((manifest.links || []).length > 6) errors.push(`${prefix}.links supports at most 6 entries`);
  (manifest.links || []).forEach((link, linkIndex) => {
    if (text(link.label).length > 40) errors.push(`${prefix}.links[${linkIndex}].label exceeds 40 characters`);
    validateUrl(link.url, `${prefix}.links[${linkIndex}].url`, errors);
  });
  validateUrl(manifest.poster, `${prefix}.poster`, errors);
  validateUrl(manifest.video, `${prefix}.video`, errors);
  if (manifest.achievement) {
    if (text(manifest.achievement.id).length > 40) errors.push(`${prefix}.achievement.id exceeds 40 characters`);
    if (text(manifest.achievement.title).length > 100) errors.push(`${prefix}.achievement.title exceeds 100 characters`);
    if (text(manifest.achievement.description).length > 500) errors.push(`${prefix}.achievement.description exceeds 500 characters`);
    validateUrl(manifest.achievement.image, `${prefix}.achievement.image`, errors);
    validateUrl(manifest.achievement.url, `${prefix}.achievement.url`, errors);
  }
  return errors;
}

const validationErrors = manifests.flatMap(validateManifest);
const projectIds = manifests.map((manifest) => text(manifest.id));
const duplicateProjectIds = projectIds.filter((id, index) => projectIds.indexOf(id) !== index);
if (duplicateProjectIds.length) validationErrors.push(`duplicate project ids in manifest: ${[...new Set(duplicateProjectIds)].join(", ")}`);
const achievementIds = manifests.filter((manifest) => manifest.achievement).map((manifest) => text(manifest.achievement.id) || `${text(manifest.id)}_ACH`);
const duplicateAchievementIds = achievementIds.filter((id, index) => achievementIds.indexOf(id) !== index);
if (duplicateAchievementIds.length) validationErrors.push(`duplicate achievement ids in manifest: ${[...new Set(duplicateAchievementIds)].join(", ")}`);
if (validationErrors.length) throw new Error(`manifest validation failed:\n- ${validationErrors.join("\n- ")}`);

async function inspectLocalMedia(manifest, index) {
  const entries = [
    ["posterFile", manifest.posterFile, imageMimes],
    ["videoFile", manifest.videoFile, videoMimes],
    ["achievement.imageFile", manifest.achievement?.imageFile, imageMimes]
  ];
  const inspected = [];
  for (const [field, relativePath, allowedMimes] of entries) {
    if (!relativePath) continue;
    const filePath = path.resolve(manifestDirectory, relativePath);
    const mime = mimeByExtension.get(path.extname(filePath).toLowerCase());
    if (!mime || !allowedMimes.has(mime)) throw new Error(`projects[${index}].${field} has an unsupported media type: ${filePath}`);
    const details = await fs.stat(filePath).catch(() => null);
    if (!details?.isFile()) throw new Error(`projects[${index}].${field} was not found: ${filePath}`);
    if (details.size > 100 * 1024 * 1024) throw new Error(`projects[${index}].${field} exceeds 100MB: ${filePath}`);
    inspected.push({ field, filePath, mime, size: details.size });
  }
  return inspected;
}

const localMediaByProject = [];
for (const [index, manifest] of manifests.entries()) localMediaByProject.push(await inspectLocalMedia(manifest, index));
const mediaCount = localMediaByProject.reduce((total, entries) => total + entries.length, 0);
if (mediaCount > 20) throw new Error(`manifest contains ${mediaCount} local media files; the server allows at most 20 uploads per administrator per hour`);

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

function verifyAgainstContent(content) {
  if (!Array.isArray(content.projects)) throw new Error("current administrator cannot read projects");
  if (content.projects.length + manifests.length > 100) throw new Error(`project limit exceeded: ${content.projects.length} existing + ${manifests.length} new`);
  if ((content.achievements || []).length + achievementIds.length > 100) throw new Error(`achievement limit exceeded: ${(content.achievements || []).length} existing + ${achievementIds.length} new`);
  const existingProjectIds = new Set(content.projects.map((project) => project.id));
  const conflictingProjects = projectIds.filter((id) => existingProjectIds.has(id));
  if (conflictingProjects.length) throw new Error(`project ids already exist: ${conflictingProjects.join(", ")}`);
  const existingAchievementIds = new Set((content.achievements || []).map((achievement) => achievement.id));
  const conflictingAchievements = achievementIds.filter((id) => existingAchievementIds.has(id));
  if (conflictingAchievements.length) throw new Error(`achievement ids already exist: ${conflictingAchievements.join(", ")}`);
}

const initialContent = await api("/api/admin/content");
verifyAgainstContent(initialContent);

if (dryRun) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    dryRun: true,
    projects: projectIds,
    achievements: achievementIds,
    localMedia: localMediaByProject.flat().map(({ field, filePath, mime, size }) => ({ field, filePath, mime, size }))
  }, null, 2)}\n`);
} else {
  async function uploadMedia(entry) {
    const data = await fs.readFile(entry.filePath);
    const form = new FormData();
    form.append("file", new Blob([data], { type: entry.mime }), path.basename(entry.filePath));
    const uploaded = await api("/api/admin/upload", { method: "POST", body: form });
    return uploaded.url;
  }

  const prepared = [];
  const uploadedByProject = manifests.map(() => ({}));
  let contentSaved = false;
  try {
    for (const [index, manifest] of manifests.entries()) {
      const uploaded = uploadedByProject[index];
      for (const entry of localMediaByProject[index]) {
        process.stderr.write(`uploading ${entry.filePath}\n`);
        uploaded[entry.field] = await uploadMedia(entry);
      }
      const project = {
        id: text(manifest.id),
        title: text(manifest.title),
        category: text(manifest.category),
        description: text(manifest.description),
        tags: Array.isArray(manifest.tags) ? manifest.tags.map(text).filter(Boolean) : [],
        color: manifest.color || "#b8ff3d",
        poster: uploaded.posterFile || manifest.poster || "",
        video: uploaded.videoFile || manifest.video || "",
        links: Array.isArray(manifest.links) ? manifest.links.map((link) => ({ label: text(link.label), url: text(link.url) })) : []
      };
      const achievement = manifest.achievement ? {
        id: text(manifest.achievement.id) || `${project.id}_ACH`,
        title: text(manifest.achievement.title) || project.title,
        type: text(manifest.achievement.type) || "项目成果",
        description: text(manifest.achievement.description) || project.description,
        date: text(manifest.achievement.date),
        projectId: project.id,
        image: uploaded["achievement.imageFile"] || manifest.achievement.image || project.poster,
        url: manifest.achievement.url || project.links.find((link) => link.url)?.url || ""
      } : null;
      prepared.push({ project, achievement });
    }

    // Refresh immediately before the single write so unrelated edits made during media upload are retained.
    const latestContent = await api("/api/admin/content");
    verifyAgainstContent(latestContent);
    const saved = await api("/api/admin/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...latestContent,
        projects: [...latestContent.projects, ...prepared.map((item) => item.project)],
        achievements: [...(latestContent.achievements || []), ...prepared.map((item) => item.achievement).filter(Boolean)]
      })
    });
    contentSaved = true;

    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: false,
      projects: prepared.map(({ project }) => saved.content.projects.find((item) => item.id === project.id)),
      achievements: prepared.filter((item) => item.achievement).map(({ achievement }) => saved.content.achievements.find((item) => item.id === achievement.id))
    }, null, 2)}\n`);
  } catch (error) {
    const hasUploadedMedia = uploadedByProject.some((uploaded) => Object.keys(uploaded).length);
    if (!contentSaved && hasUploadedMedia) {
      const recoveryPath = `${manifestPath}.recovery-${Date.now()}.json`;
      const recoveryProjects = manifests.map((manifest, index) => {
        const uploaded = uploadedByProject[index];
        return {
          ...manifest,
          poster: uploaded.posterFile || manifest.poster || "",
          posterFile: uploaded.posterFile ? undefined : manifest.posterFile,
          video: uploaded.videoFile || manifest.video || "",
          videoFile: uploaded.videoFile ? undefined : manifest.videoFile,
          achievement: manifest.achievement ? {
            ...manifest.achievement,
            image: uploaded["achievement.imageFile"] || manifest.achievement.image || "",
            imageFile: uploaded["achievement.imageFile"] ? undefined : manifest.achievement.imageFile
          } : undefined
        };
      });
      await fs.writeFile(recoveryPath, `${JSON.stringify({ projects: recoveryProjects }, null, 2)}\n`, { mode: 0o600 });
      throw new Error(`${error.message}\nuploaded media was preserved in a resumable manifest: ${recoveryPath}`);
    }
    throw error;
  }
}
