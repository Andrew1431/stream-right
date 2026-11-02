// Builds and deploys. Adds --domain for each entry in CUSTOM_DOMAIN (from the environment or .env).
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync(".env")) process.loadEnvFile(".env");

const domains = (process.env.CUSTOM_DOMAIN ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

function run(cmd, args) {
  const { status } = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (status !== 0) process.exit(status ?? 1);
}

run("npm", ["run", "build"]);
run("npx", ["wrangler", "deploy", ...domains.flatMap((d) => ["--domain", d]), ...process.argv.slice(2)]);
