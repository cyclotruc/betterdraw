// Writes web/dist/licenses.txt, served at /licenses.txt: THIRD_PARTY_NOTICES.txt, then the license of every
// production dependency (what ends up on the server and in the web app).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const seen = new Map();

function find(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return p;
    if (dir === dirname(dir)) return null;
  }
}

function visit(name, from) {
  const dir = find(name, from);
  if (!dir) return;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(", "));
  seen.set(key, { license: license || "see text", text: file ? readFileSync(join(dir, file), "utf8").trim() : "" });
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dir);
}

// The app's own dependencies, those of the package.json files given as arguments (a build that adds dependencies
// of its own), then those of its packages (packages/*, which are ours and covered by LICENSE).
const app = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const own = (name) => name.startsWith("@betterdraw/");
for (const dep of Object.keys(app.dependencies)) visit(dep, root);
for (const file of process.argv.slice(2)) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dirname(resolve(file)));
}
for (const name of readdirSync(join(root, "packages"))) {
  const file = join(root, "packages", name, "package.json");
  if (!existsSync(file)) continue;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) if (!own(dep)) visit(dep, dirname(file));
}

// The fonts, icons and code copied into the source tree come first, from THIRD_PARTY_NOTICES.txt, then the packages.
const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.txt"), "utf8").trim();
const rule = "=".repeat(72);
const out = [
  `${app.name} ${app.version} includes the following open-source software.`,
  "",
  notices,
  "",
  `${rule}\nNPM PACKAGES\n${rule}\n\nThe npm packages that the server and the web app use, each with its license.\n`,
  ...[...seen]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { license, text }]) => `${rule}\n${key} (${license})\n${text ? "\n" + text + "\n" : ""}`),
].join("\n");
writeFileSync(join(root, "web/dist/licenses.txt"), out);
console.log(`licenses: ${seen.size} packages`);
