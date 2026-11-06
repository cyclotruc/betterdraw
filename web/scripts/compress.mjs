// Pre-compresses the built web app (brotli and gzip) so the server never compresses at request time.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
let before = 0,
  after = 0;
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.(js|mjs|css|html|svg|json|txt|webmanifest|wasm)$/.test(f) || statSync(p).size < 1024) continue;
    const body = readFileSync(p);
    const br = brotliCompressSync(body, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length },
    });
    writeFileSync(p + ".br", br);
    writeFileSync(p + ".gz", gzipSync(body, { level: 9 }));
    before += body.length;
    after += br.length;
  }
};
walk(dist);
console.log(`compress: ${(before / 1e6).toFixed(1)} MB of text → ${(after / 1e6).toFixed(1)} MB with brotli`);
