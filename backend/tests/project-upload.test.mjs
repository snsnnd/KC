import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = "http://127.0.0.1:3107";
const dataDirectory = path.join(os.tmpdir(), "tech-club-project-upload-test");
const adminPassword = "isolated-admin-password";
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
const uploadScriptPath = fileURLToPath(new URL("../scripts/upload-project.mjs", import.meta.url));
const manifestPath = path.join(dataDirectory, "projects.json");
const posterPath = path.join(dataDirectory, "SYS_BATCH_01-poster-v1.png");
const invalidPosterPath = path.join(dataDirectory, "SYS_FAIL_02-poster-v1.png");
const failureManifestPath = path.join(dataDirectory, "projects-failure.json");

await fs.rm(dataDirectory, { recursive: true, force: true });
await fs.mkdir(dataDirectory, { recursive: true });
await fs.writeFile(posterPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
await fs.writeFile(invalidPosterPath, "not a png");
await fs.writeFile(manifestPath, JSON.stringify({ projects: [
  { id: "SYS_BATCH_01", title: "批量上传项目一", category: "测试", description: "验证批量项目和本地海报上传。", tags: ["BATCH"], posterFile: path.basename(posterPath), links: [] },
  { id: "SYS_BATCH_02", title: "批量上传项目二", category: "测试", description: "验证整批项目只执行一次内容写入。", tags: ["BATCH"], poster: "https://example.com/poster.webp", links: [], achievement: { id: "ACH_BATCH_02", title: "批量上传成果", description: "关联第二个批量项目。" } }
] }, null, 2));
await fs.writeFile(failureManifestPath, JSON.stringify({ projects: [
  { id: "SYS_FAIL_01", title: "部分失败项目一", category: "测试", description: "第一个媒体上传成功。", posterFile: path.basename(posterPath) },
  { id: "SYS_FAIL_02", title: "部分失败项目二", category: "测试", description: "第二个媒体内容校验失败。", posterFile: path.basename(invalidPosterPath) }
] }, null, 2));

const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: "3107", DATA_DIR: dataDirectory, ADMIN_PASSWORD: adminPassword, SESSION_SECRET: "isolated-project-upload-secret-at-least-32", COOKIE_SECURE: "false" },
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

function runUpload(targetManifestPath = manifestPath, extraArguments = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [uploadScriptPath, targetManifestPath, ...extraArguments], {
      env: { ...process.env, BASE_URL: base, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: adminPassword },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

try {
  await waitForServer();
  const before = await fetch(`${base}/api/content`).then((response) => response.json());

  const dryRun = await runUpload(manifestPath, ["--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).dryRun, true);
  const afterDryRun = await fetch(`${base}/api/content`).then((response) => response.json());
  assert.equal(afterDryRun.projects.length, before.projects.length);

  const partialFailure = await runUpload(failureManifestPath);
  assert.notEqual(partialFailure.code, 0);
  assert.match(partialFailure.stderr, /resumable manifest/);
  const recoveryName = (await fs.readdir(dataDirectory)).find((name) => name.startsWith("projects-failure.json.recovery-"));
  assert.ok(recoveryName);
  const recovery = JSON.parse(await fs.readFile(path.join(dataDirectory, recoveryName), "utf8"));
  assert.match(recovery.projects[0].poster, /^\/uploads\//);
  assert.equal(recovery.projects[0].posterFile, undefined);
  assert.equal(recovery.projects[1].posterFile, path.basename(invalidPosterPath));
  const afterPartialFailure = await fetch(`${base}/api/content`).then((response) => response.json());
  assert.equal(afterPartialFailure.projects.length, before.projects.length);

  const uploaded = await runUpload();
  assert.equal(uploaded.code, 0, uploaded.stderr);
  const result = JSON.parse(uploaded.stdout);
  assert.equal(result.projects.length, 2);
  assert.equal(result.achievements.length, 1);
  assert.match(result.projects[0].poster, /^\/uploads\//);

  const publicContent = await fetch(`${base}/api/content`).then((response) => response.json());
  assert.ok(publicContent.projects.some((project) => project.id === "SYS_BATCH_01"));
  assert.ok(publicContent.projects.some((project) => project.id === "SYS_BATCH_02"));
  assert.ok(publicContent.achievements.some((achievement) => achievement.id === "ACH_BATCH_02"));

  const duplicate = await runUpload(manifestPath, ["--dry-run"]);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /project ids already exist/);

  console.log(JSON.stringify({ ok: true, dryRunReadOnly: true, partialFailureRecovery: true, batchWrite: true, localMediaUploaded: true, duplicateRejected: true }));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await fs.rm(dataDirectory, { recursive: true, force: true });
}
