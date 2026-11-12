// scripts/generate-static.js
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

const publicDir = path.resolve("root/public");
fs.mkdirSync(publicDir, { recursive: true });

const indexFile = path.join(publicDir, "index.html");
const notFoundFile = path.join(publicDir, "404.html");

function findFileRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

async function captureFromServer() {
  if (!fs.existsSync(".env") && fs.existsSync(".env.example")) {
    fs.copyFileSync(".env.example", ".env");
  }

  // Ensure SQLite parent directories exist
  fs.mkdirSync(path.resolve("var"), { recursive: true });
  fs.mkdirSync(path.resolve("root/var"), { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_CLIENT: "sqlite",
    DATABASE_FILENAME: "/tmp/keybr-build.sqlite",
    PORT: "3000",
  };

  // Isolate initdb so any failure logs a warning without aborting SSR capture
  try {
    if (fs.existsSync("./root/initdb.js")) {
      execSync("node --enable-source-maps ./root/initdb.js", {
        stdio: "inherit",
        env,
      });
    } else if (fs.existsSync("./packages/devenv/lib/initdb.ts")) {
      execSync(
        "node --experimental-strip-types ./packages/devenv/lib/initdb.ts",
        { stdio: "inherit", env }
      );
    }
  } catch (err) {
    console.warn("Optional initdb step skipped:", err.message);
  }

  if (!fs.existsSync("./root/index.js")) {
    console.warn("./root/index.js not found, skipping SSR capture.");
    return false;
  }

  const server = spawn("node", ["--enable-source-maps", "./root/index.js"], {
    env,
    stdio: "inherit",
  });

  try {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (server.exitCode !== null) {
        console.warn(`Server exited early with code ${server.exitCode}`);
        return false;
      }
      try {
        const res = await fetch("http://localhost:3000/", {
          headers: { Host: "localhost:3000" },
        });
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
  console.log("Generating static HTML from emitted manifest.json...");
  const manifestPath = findFileRecursive(publicDir, "manifest.json");

  let assetPrefix = "/";
  const cssFiles = new Set();
  const jsFiles = new Set();

  if (manifestPath) {
    const manifestDir = path.dirname(manifestPath);
    const relDir = path.relative(publicDir, manifestDir).replace(/\\/g, "/");
    assetPrefix = relDir ? `/${relDir}/` : "/";
    console.log(`Found manifest.json at ${manifestPath} (prefix: ${assetPrefix})`);

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    const collectAssets = (val) => {
      if (!val) return;
      if (typeof val === "string") {
        if (val.endsWith(".css")) cssFiles.add(val);
        if (val.endsWith(".js")) jsFiles.add(val);
      } else if (Array.isArray(val)) {
        val.forEach(collectAssets);
      } else if (typeof val === "object") {
        if (val.browser) {
          collectAssets(val.browser);
        } else {
          Object.values(val).forEach(collectAssets);
        }
      }
    };

    if (raw && typeof raw === "object") {
      if (raw.entrypoints && raw.entrypoints.browser) {
        collectAssets(raw.entrypoints.browser);
      } else if (raw.browser) {
        collectAssets(raw.browser);
      } else {
        collectAssets(raw);
      }
    }
  }

  // Directory scan fallback if manifest structure did not match
  if (cssFiles.size === 0 || jsFiles.size === 0) {
    const assetDir = manifestPath ? path.dirname(manifestPath) : publicDir;
    const relDir = path.relative(publicDir, assetDir).replace(/\\/g, "/");
    assetPrefix = relDir ? `/${relDir}/` : "/";
    if (fs.existsSync(assetDir)) {
      for (const file of fs.readdirSync(assetDir)) {
        if (file.endsWith(".css")) cssFiles.add(file);
        if (file.endsWith(".js")) jsFiles.add(file);
      }
    }
  }

  const normalizeUrl = (file) =>
    file.startsWith("/") || file.startsWith("http")
      ? file
      : `${assetPrefix}${file.replace(/^\.?\//, "")}`;

  const cssLinks = [...cssFiles]
    .map((f) => `<link rel="stylesheet" href="${normalizeUrl(f)}">`)
    .join("\n  ");

  const jsScripts = [...jsFiles]
    .map((f) => `<script defer src="${normalizeUrl(f)}"></script>`)
    .join("\n  ");

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
  <main></main>
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
  console.warn("SSR capture failed, using manifest fallback:", err.message);
  await generateFallbackFromManifest();
}
