import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import web from "./web/plugin.js";

const PYODIDE_VERSION = "314.0.7"; // keep in step with "pyodide" in package.json
// From Pyodide's own repository (with their dependencies): the API, and what the statement parsers need.
const PYODIDE_PACKAGES = ["fastapi", "cryptography", "pillow", "xlrd", "charset-normalizer"];
// Pure-Python wheels from PyPI, pinned: reading PDFs and .xlsx files in the browser.
const pypi = (project, file, sha256) => ({
  file,
  sha256,
  url: `https://files.pythonhosted.org/packages/${file.split("-").at(-3)}/${project[0]}/${project}/${file}`,
});
const EXTRA_WHEELS = [
  pypi("pdfplumber", "pdfplumber-0.11.10-py3-none-any.whl", "7741ea81bf165b474b153e6789d10d18e06b6ddcf3ec84289c3ef2fed6802580"),
  pypi("pdfminer.six", "pdfminer_six-20260107-py3-none-any.whl", "366585ba97e80dffa8f00cebe303d2f381884d8637af4ce422f1df3ef38111a9"),
  pypi("openpyxl", "openpyxl-3.1.5-py2.py3-none-any.whl", "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2"),
  pypi("et_xmlfile", "et_xmlfile-2.0.0-py3-none-any.whl", "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa"),
];

// The PC build never starts the web engine; Vite still writes the worker file, so leave it out.
const dropWebEngine = {
  name: "drop-web-engine",
  apply: "build",
  generateBundle(_options, bundle) {
    for (const file of Object.keys(bundle)) if (file.includes("engine.worker")) delete bundle[file];
  },
};

// `vite build` makes the PC dashboard (frontend/dist, served by run.py).
// `vite build --mode web` makes the web app (frontend/dist-web), synced with a Google Drive folder; Vercel runs this.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const driveApi = env.VITE_DRIVE_API || "https://www.googleapis.com";
  return {
    base: "./",
    plugins: [
      react(),
      mode === "web" ? web({ pyodideVersion: PYODIDE_VERSION, packages: PYODIDE_PACKAGES, extraWheels: EXTRA_WHEELS, driveApi }) : dropWebEngine,
    ],
    publicDir: mode === "web" ? "web/public" : false,
    define: {
      __PYODIDE_VERSION__: JSON.stringify(PYODIDE_VERSION),
      __PYODIDE_PACKAGES__: JSON.stringify(PYODIDE_PACKAGES),
      __EXTRA_WHEELS__: JSON.stringify(EXTRA_WHEELS.map((w) => w.file)),
    },
    worker: { format: "es" },
    build: { outDir: mode === "web" ? "dist-web" : "dist", emptyOutDir: true },
    server: {
      proxy: { "/api": "http://127.0.0.1:8765" },
      fs: { allow: [".."] }, // the web engine bundles ../backend/**/*.py
    },
  };
});
