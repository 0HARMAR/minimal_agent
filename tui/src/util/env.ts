import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const candidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.env["HOME"] ?? "/home", ".config", "minimal-agent", ".env"),
  resolve(process.env["HOME"] ?? "/home", ".minimal_agent.env"),
  resolve("/home/harmar/minimal_agent/.env"),
];

for (const p of candidates) {
  loadEnvFile(p);
}
