#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dataDirectory = "/var/lib/tech-club";
const environmentFile = "/etc/tech-club-cms.env";
const command = process.argv[2];
const fileName = process.argv[3] || "";
const inputFile = process.argv[4] || "";

if (process.getuid?.() !== 0) throw new Error("must run as root");

const allowedFiles = new Set(fs.readdirSync(dataDirectory).filter((name) => name.endsWith(".json") && !name.endsWith(".enc.json")));
const secretMatch = fs.readFileSync(environmentFile, "utf8").match(/^SESSION_SECRET=([0-9a-fA-F]{64})$/m);
if (!secretMatch) throw new Error("valid SESSION_SECRET not found");
const key = crypto.createHash("sha256").update(secretMatch[1]).digest();

function resolveDataFile(name) {
  if (!allowedFiles.has(name) || path.basename(name) !== name) throw new Error("unknown data file");
  return path.join(dataDirectory, name);
}

function decrypt(envelope) {
  if (envelope?.version !== 1 || !envelope.iv || !envelope.tag || !envelope.data) throw new Error("file is not an encrypted version 1 envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

if (command === "list") {
  process.stdout.write(`${[...allowedFiles].sort().join("\n")}\n`);
} else if (command === "read") {
  const value = decrypt(JSON.parse(fs.readFileSync(resolveDataFile(fileName), "utf8")));
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
} else if (command === "write") {
  if (!inputFile) throw new Error("usage: tech-club-data write FILE INPUT_JSON");
  try {
    execFileSync("systemctl", ["is-active", "--quiet", "tech-club-cms.service"]);
    throw new Error("stop tech-club-cms.service before writing data");
  } catch (error) {
    if (error.message === "stop tech-club-cms.service before writing data") throw error;
  }
  const target = resolveDataFile(fileName);
  const value = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(encrypt(value), null, 2)}\n`, { mode: 0o600 });
  fs.chownSync(temporary, 0, 0);
  fs.renameSync(temporary, target);
  process.stdout.write(`updated ${target}\n`);
} else {
  throw new Error("usage: tech-club-data list | read FILE | write FILE INPUT_JSON");
}
