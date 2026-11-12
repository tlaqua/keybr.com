// scripts/generate-static.js
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const publicDir = path.resolve("root/public");
const indexFile = path.join(publicDir, "index.html");
const notFoundFile = path.join(publicDir, "404.html");

async function captureFromServer() {
  if (!fs.existsSync(".env") && fs.existsSync(".env.example")) {
    fs.copyFileSync(".env.example", ".env");
  }

  // Initialize local SQLite DB using compiled devenv package
  execSync("node ./packages/devenv/lib/initdb.js", {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production", DATABASE_CLIENT: "sqlite" },
  });

  const server = spawn("node", ["--enable-source-maps", "./root/index.js"], {
    env: { ...process.env, NODE_ENV: "production", PORT: "3000" },
    stdio: "inherit",
  });

  try {
    // Poll localhost:3000 until the server responds
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch("http://127.0.0.1:3000/");
        if (res.ok) {
          const html = await res.text();
          fs.writeFileSync(indexFile, html, "utf8");
          fs.writeFileSync(notFoundFile, html, "utf8");
          console.log("Successfully captured SSR index.html and 404.html");
          return true;
        }
      } catch {
        // Server still starting
      }
    }
    return false;
  } finally {
    server.kill("SIGTERM");
  }
}

async function generateFallbackFromManifest() {
  console.log("Falling back to webpack-manifest.js static HTML generation...");
  const manifestPath = path.resolve("webpack-manifest.js");
  let cssLinks = "";
  let jsScripts = "";

  if (fs.existsSync(manifestPath)) {
    const { default: manifest } = await import(manifestPath);
    for (const [key, value] of Object.entries(manifest)) {
      if (String(key).endsWith(".css")) {
        cssLinks += `<link rel="stylesheet" href="/assets/${value}">\n`;
      }
    }
    const practiceJs =
      manifest["page-practice.js"] ||
      Object.values(manifest).find((v) => String(v).endsWith(".js"));
    if (practiceJs) {
      jsScripts += `<script type="module" src="/assets/${practiceJs}"></script>\n`;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="system" data-font="open-sans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>keybr.com - Typing Practice</title>
  <link rel="icon" href="/favicon.ico">
  ${cssLinks}
</head>
<body>
  <div id="root"></div>
  ${jsScripts}
</body>
</html>`;

  fs.writeFileSync(indexFile, html, "utf8");
  fs.writeFileSync(notFoundFile, html, "utf8");
  console.log("Wrote static index.html and 404.html to root/public/");
}

try {
  const ok = await captureFromServer();
  if (!ok) await generateFallbackFromManifest();
} catch (err) {
  console.warn("SSR capture skipped:", err.message);
  await generateFallbackFromManifest();
}
