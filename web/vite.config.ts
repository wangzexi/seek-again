import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import packageJson from "../package.json" with { type: "json" };

const dist = resolve(import.meta.dirname, "../dist");
const publicDir = resolve(import.meta.dirname, "public");
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

function distribute(): Plugin {
  return {
    name: "seekagain-distribution",
    apply: "build",
    async writeBundle(_, bundle) {
      const indexPath = resolve(dist, "index.html");
      // IIFE output and a classic script let the same build open over file://.
      const html = (await readFile(indexPath, "utf8"))
        .replace('<script type="module" crossorigin', "<script defer")
        .replace('<link rel="stylesheet" crossorigin', '<link rel="stylesheet"')
        .replace(
          "</head>",
          `  <meta name="application-version" content="${packageJson.version}" />\n  </head>`,
        );
      await writeFile(indexPath, html);
      const assets = [...Object.keys(bundle), ...(await readdir(publicDir))].sort();
      const worker = await readFile(
        new URL("./src/pwa/service-worker.js", import.meta.url),
        "utf8",
      );
      const hash = createHash("sha256").update(worker);
      for (const name of assets) {
        hash.update(name).update(new Uint8Array(await readFile(resolve(dist, name))));
      }
      const build = { version: hash.digest("hex"), assets };
      await writeFile(
        resolve(dist, "service-worker.js"),
        `const build = ${JSON.stringify(build)};\n${worker}`,
      );
      await writeFile(
        resolve(dist, "LICENSE"),
        new Uint8Array(await readFile(new URL("../LICENSE", import.meta.url))),
      );

      const textAssets = [...assets, "service-worker.js"].filter((name) =>
        /\.(?:html|js|css|svg|webmanifest)$/.test(name),
      );
      await Promise.all(
        textAssets.map(async (name) => {
          const path = resolve(dist, name);
          const source = new Uint8Array(await readFile(path));
          const [br, gz] = await Promise.all([
            compressBrotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
            compressGzip(source, { level: 9 }),
          ]);
          if (br.byteLength < source.byteLength) await writeFile(path + ".br", new Uint8Array(br));
          if (gz.byteLength < source.byteLength) await writeFile(path + ".gz", new Uint8Array(gz));
        }),
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), distribute()],
  server: { port: 8090 },
  css: { modules: { generateScopedName: "[local]-[hash:base64:6]" } },
  build: {
    outDir: dist,
    emptyOutDir: true,
    target: ["chrome105", "edge105", "safari16", "firefox110"],
    assetsInlineLimit: 0,
    modulePreload: false,
    cssCodeSplit: false,
    minify: "oxc",
    cssMinify: "lightningcss",
    reportCompressedSize: false,
    rolldownOptions: {
      transform: {
        define: { "import.meta.url": "__seekAgainScriptUrl", "import.meta.resolve": "undefined" },
      },
      output: {
        format: "iife",
        codeSplitting: false,
        intro: "const __seekAgainScriptUrl = document.currentScript?.src ?? document.baseURI;",
      },
    },
  },
});
