import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import phone from "./phone/plugin.js";

const PYODIDE_VERSION = "314.0.7"; // keep in step with "pyodide" in package.json

// The PC build never starts the phone engine; Vite still writes the worker file, so leave it out.
const dropPhoneEngine = {
  name: "drop-phone-engine",
  apply: "build",
  generateBundle(_options, bundle) {
    for (const file of Object.keys(bundle)) if (file.includes("engine.worker")) delete bundle[file];
  },
};

// `vite build` makes the PC dashboard (frontend/dist, served by run.py).
// `vite build --mode phone` makes the view-only phone app (frontend/dist-phone, deployed to Vercel).
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), mode === "phone" ? phone({ pyodideVersion: PYODIDE_VERSION }) : dropPhoneEngine],
  publicDir: mode === "phone" ? "phone/public" : false,
  define: { __PYODIDE_VERSION__: JSON.stringify(PYODIDE_VERSION) },
  worker: { format: "es" },
  build: { outDir: mode === "phone" ? "dist-phone" : "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://127.0.0.1:8765" },
    fs: { allow: [".."] }, // the phone engine bundles ../backend/**/*.py
  },
}));
