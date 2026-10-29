// Vite plugin for the phone build (`npm run build:phone`):
// - phone-only <head> tags and a strict Content-Security-Policy,
// - the Pyodide runtime plus the wheels FastAPI needs, served from the app itself (no CDN at run time),
// - sw.js with the list of every file to keep on the phone.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const sha256 = (data, enc = "hex") => createHash("sha256").update(data).digest(enc);

/** Wheels for `packages` and everything they depend on, per pyodide-lock.json. */
function wheelsFor(lock, packages) {
  const norm = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");
  const byName = new Map(Object.values(lock.packages).map((p) => [norm(p.name), p]));
  const seen = new Map();
  const visit = (name) => {
    const pkg = byName.get(norm(name));
    if (!pkg) throw new Error(`${name} isn't in pyodide-lock.json`);
    if (seen.has(pkg.name)) return;
    seen.set(pkg.name, pkg);
    pkg.depends.forEach(visit);
  };
  packages.forEach(visit);
  return [...seen.values()].filter((p) => p.file_name.endsWith(".whl"));
}

async function cachedWheel(version, pkg, cacheDir) {
  const file = path.join(cacheDir, pkg.file_name);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === pkg.sha256) return fs.readFileSync(file);
  const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${pkg.file_name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${url} (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (sha256(data) !== pkg.sha256) throw new Error(`${pkg.file_name}: checksum doesn't match pyodide-lock.json`);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(file, data);
  return data;
}

export default function phone({ pyodideVersion, packages = ["fastapi"] }) {
  const pyodideDir = path.resolve(here, "../node_modules/pyodide");
  const cacheDir = path.resolve(here, "../.pyodide-cache", pyodideVersion);
  let publicFiles = [];
  return {
    name: "finance-master-phone",
    apply: "build",
    configResolved(config) {
      const dir = config.publicDir;
      publicFiles = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f !== "vercel.json") : [];
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        // the only inline script (the theme) is allowed by its hash
        const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${sha256(m[1], "base64")}'`);
        const csp = [
          "default-src 'self'",
          `script-src 'self' 'wasm-unsafe-eval' ${inline.join(" ")}`,
          "worker-src 'self'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join("; ");
        const head = [
          `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
          `<meta name="referrer" content="no-referrer" />`,
          `<link rel="manifest" href="./manifest.webmanifest" />`,
          `<link rel="apple-touch-icon" href="./icon-180.png" />`,
          `<meta name="mobile-web-app-capable" content="yes" />`,
          `<meta name="apple-mobile-web-app-capable" content="yes" />`,
          `<meta name="apple-mobile-web-app-title" content="Finance" />`,
          `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
        ];
        return html.replace("<head>", `<head>\n    ${head.join("\n    ")}`);
      },
    },
    async generateBundle(_options, bundle) {
      const installed = JSON.parse(fs.readFileSync(path.join(pyodideDir, "package.json"), "utf8")).version;
      if (installed !== pyodideVersion) {
        throw new Error(`node_modules/pyodide is ${installed}, expected ${pyodideVersion}. Run npm install.`);
      }
      const lock = JSON.parse(fs.readFileSync(path.join(pyodideDir, "pyodide-lock.json"), "utf8"));
      const runtime = [];
      for (const pkg of wheelsFor(lock, packages)) runtime.push([pkg.file_name, await cachedWheel(pyodideVersion, pkg, cacheDir)]);
      for (const f of CORE) runtime.push([f, fs.readFileSync(path.join(pyodideDir, f))]);
      runtime.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, source] of runtime) {
        this.emitFile({ type: "asset", fileName: `pyodide/${pyodideVersion}/${name}`, source });
      }
      const assets = Object.keys(bundle).filter((f) => f.startsWith("assets/")).sort();
      const precache = ["./", ...assets.map((f) => `./${f}`), ...publicFiles.sort().map((f) => `./${f}`),
        ...runtime.map(([name]) => `./pyodide/${pyodideVersion}/${name}`)];
      const build = sha256(precache.join("\n") + assets.map((f) => bundle[f].code ?? bundle[f].source).join("")).slice(0, 12);
      const sw = fs.readFileSync(path.join(here, "sw.js"), "utf8")
        .replace("__BUILD__", JSON.stringify(build))
        .replace("__PRECACHE__", JSON.stringify(precache));
      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
    },
  };
}
