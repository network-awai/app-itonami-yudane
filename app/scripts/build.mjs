// Static build (AWAI-3502): dist/ holds the whole app for the Tauri v3 shell.
// The repo's own .cljk domain is compiled with ClojureScript (as .cljc, the
// extension the compiler reads) together with src/cljs and the pinned
// kotoba.lang.text into one script, dist/domain.js. A compiler warning fails
// the build: a :clj-only form silently missing in ClojureScript must not ship.
import { mkdir, copyFile, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
const meta = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const app = meta.itonami;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const pinFile of ["vendor/PINS.json", "vendor/cljs/PINS.json"]) {
  const pins = JSON.parse(await readFile(resolve(root, pinFile), "utf8"));
  for (const [name, digest] of Object.entries(pins.files)) {
    if (sha(await readFile(resolve(root, dirname(pinFile), name))) !== digest) throw new Error(`pin drift: ${pinFile} ${name}`);
  }
}

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}
const src = resolve(root, "build/cljs-src");
await rm(resolve(root, "build"), { recursive: true, force: true });
const copied = [];
// A source entry is a directory relative to app/, optionally "dir=>prefix" when the
// directory is not itself a classpath root (e.g. ../methods holding umisachi.methods.*).
const sourceRoots = [...app.cljsSources.map((d) => { const [dir, prefix = ""] = d.split("=>"); return [resolve(root, dir), prefix]; }),
  [resolve(root, "vendor/cljs"), ""], [resolve(root, "src/cljs"), ""]];
for (const [dir, prefix] of sourceRoots) {
  for await (const f of walk(dir)) {
    if (!/\.clj[kcs]$/.test(f) || /\.clj\.cljk$/.test(f)) continue;
    const dest = join(src, prefix, relative(dir, f).replace(/\.cljk$/, ".cljc"));
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(f, dest);
    copied.push(relative(src, dest));
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// cljs prints its warnings on stderr. JVM notices (sun.misc.Unsafe from the Closure jar) and the
// namespace-munging notice for a segment such as `methods` are not compiler findings about the code.
const r = spawnSync("clojure", ["-M", "-m", "cljs.main", "-co", "{:browser-repl false}", "-d", "build/cljs-out", "-o", "dist/domain.js", "-O", "advanced", "-c", "itonami.app.entry"],
  { cwd: root, encoding: "utf8" });
const log = (r.stdout ?? "") + (r.stderr ?? "");
if (r.status !== 0) throw new Error("ClojureScript build failed:\n" + log);
const findings = log.split("\n").filter((l) => /WARNING/.test(l)
  && !/sun\.misc\.Unsafe|Please consider reporting|will be removed in a future release|jarjar/.test(l)
  && !/contains a reserved JavaScript keyword, the corresponding Google Closure namespace will be munged/.test(l));
if (findings.length) throw new Error("ClojureScript warnings:\n" + findings.join("\n"));

for (const name of ["index.html", "style.css", "app.js"]) await copyFile(resolve(root, "src/ui", name), join(out, name));
await copyFile(resolve(root, "src/local-store.js"), join(out, "local-store.js"));
const def = (await readFile(resolve(root, "src/app-def.js"), "utf8"))
  .replace("__TITLE__", JSON.stringify(app.title)).replace("__DESCRIPTION__", JSON.stringify(app.description))
  .replace("__DID__", JSON.stringify(`did:web:${app.storageKey.split(".")[1]}.itonami.cloud`)).replace("__STORAGE_KEY__", JSON.stringify(app.storageKey));
await writeFile(join(out, "app-def.js"), def);

const descriptor = {
  schema: "kotoba.app.client-runtime.v1", target: "browser", profile: "trusted-page-v1", entry: "index.html",
  "local-state": { adapter: "localstorage", schema: app.storageKey, version: 1 }, workers: [], operations: [],
};
await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
const names = ["index.html", "style.css", "app.js", "local-store.js", "app-def.js", "domain.js", "descriptor.json"];
const files = {};
for (const name of names) files[name] = sha(await readFile(join(out, name)));
await writeFile(join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: app.id, version: meta.version, tauri: "3.0.0-alpha.6",
  runtimePins: JSON.parse(await readFile(resolve(root, "vendor/PINS.json"), "utf8")),
  cljsPins: JSON.parse(await readFile(resolve(root, "vendor/cljs/PINS.json"), "utf8")),
  cljsSources: copied.sort(), files,
}, null, 2) + "\n");
console.log(`${app.title} static build: ${names.length} pinned files, ${copied.length} ClojureScript sources`);
