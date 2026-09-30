#!/usr/bin/env node
// ================================================================
// 科创社 CMS — 加密数据管理脚本
// 功能：列出/读取/写入被 AES-256-GCM 加密的 JSON 数据文件。
// 加密密钥派生自 SESSION_SECRET 环境变量。
// 部署路径: /usr/local/sbin/tech-club-data.mjs (root:root, 0700)
// 用法: tech-club-data list
//       tech-club-data read FILE
//       tech-club-data write FILE INPUT_JSON
// 安全注意：必须在停止 CMS 服务后才能执行写操作，防止数据竞争。
// ================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 数据目录 —— 存放加密的 JSON 数据文件
const dataDirectory = "/var/lib/tech-club";
// 环境文件路径 —— 从中读取 SESSION_SECRET
const environmentFile = "/etc/tech-club-cms.env";
// 命令行参数
const command = process.argv[2];
const fileName = process.argv[3] || "";
const inputFile = process.argv[4] || "";

// 安全注意：数据操作敏感，必须 root 权限运行
if (process.getuid?.() !== 0) throw new Error("must run as root");

// 允许的数据文件集合：dataDirectory 下所有 .json 结尾且不是 .enc.json 的文件
// 安全注意：白名单机制防止读写未授权的文件
const allowedFiles = new Set(fs.readdirSync(dataDirectory).filter((name) => name.endsWith(".json") && !name.endsWith(".enc.json")));
// 从环境文件中提取 SESSION_SECRET（必须为 64 位十六进制字符串）
const secretMatch = fs.readFileSync(environmentFile, "utf8").match(/^SESSION_SECRET=([0-9a-fA-F]{64})$/m);
if (!secretMatch) throw new Error("valid SESSION_SECRET not found");
// 通过 SHA-256 派生 AES-256 密钥（32 字节）
const key = crypto.createHash("sha256").update(secretMatch[1]).digest();

// 解析数据文件的完整路径，验证文件名在许可白名单中
function resolveDataFile(name) {
  // 安全注意：同时检查 basename === name 防止路径遍历攻击
  if (!allowedFiles.has(name) || path.basename(name) !== name) throw new Error("unknown data file");
  return path.join(dataDirectory, name);
}

// AES-256-GCM 解密函数
// envelope 格式: { version: 1, iv: base64, tag: base64, data: base64 }
// GCM 模式会同时验证数据完整性和真实性（认证加密）
function decrypt(envelope) {
  if (envelope?.version !== 1 || !envelope.iv || !envelope.tag || !envelope.data) throw new Error("file is not an encrypted version 1 envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
}

// AES-256-GCM 加密函数
// 每次加密使用随机 12 字节 IV，确保同一数据每次加密结果不同
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

// 命令分发
if (command === "list") {
  // 列出所有可用的数据文件（排序后输出）
  process.stdout.write(`${[...allowedFiles].sort().join("\n")}\n`);
} else if (command === "read") {
  // 读取并解密指定文件，以美化 JSON 格式输出明文
  const value = decrypt(JSON.parse(fs.readFileSync(resolveDataFile(fileName), "utf8")));
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
} else if (command === "write") {
  // 写入加密数据文件
  if (!inputFile) throw new Error("usage: tech-club-data write FILE INPUT_JSON");
  // 安全注意：写操作前必须确保 CMS 服务已停止
  try {
    execFileSync("systemctl", ["is-active", "--quiet", "tech-club-cms.service"]);
    throw new Error("stop tech-club-cms.service before writing data");
  } catch (error) {
    if (error.message === "stop tech-club-cms.service before writing data") throw error;
  }
  const target = resolveDataFile(fileName);
  const value = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  // 原子写入：先写入临时文件，再 rename 替换目标文件
  const temporary = `${target}.${process.pid}.tmp`;
  // 安全注意：临时文件权限 600，属主 root
  fs.writeFileSync(temporary, `${JSON.stringify(encrypt(value), null, 2)}\n`, { mode: 0o600 });
  fs.chownSync(temporary, 0, 0);
  fs.renameSync(temporary, target);
  process.stdout.write(`updated ${target}\n`);
} else {
  throw new Error("usage: tech-club-data list | read FILE | write FILE INPUT_JSON");
}
