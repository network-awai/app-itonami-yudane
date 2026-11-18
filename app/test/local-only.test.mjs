// AWAI-3502: the app stays on the device, and every action's example runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(resolve(root, p), "utf8");
const meta = JSON.parse(await read("package.json"));

test("descriptor declares local state and no external operation", async () => {
  const d = JSON.parse(await read("dist/descriptor.json"));
  assert.equal(d.schema, "kotoba.app.client-runtime.v1");
  assert.deepEqual(d.operations, []);
  assert.equal(d["local-state"].schema, meta.itonami.storageKey);
});

test("shipped JavaScript has no network API", async () => {
  for (const f of await readdir(resolve(root, "dist"))) {
    if (!f.endsWith(".js")) continue;
    const s = await read("dist/" + f);
    for (const api of [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /importScripts/]) assert.doesNotMatch(s, api, `${f}: ${api}`);
  }
});

test("CSP is strict in the page and in Tauri", async () => {
  const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const html = await read("dist/index.html");
  for (const csp of [conf.app.security.csp, html.match(/Content-Security-Policy" content="([^"]+)"/)[1]]) {
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src ipc: http:\/\/ipc\.localhost;/);
    assert.doesNotMatch(csp, /unsafe-|https?:\/\/(?!ipc\.localhost)/);
  }
  assert.equal(conf.identifier, meta.itonami.id);
});

test("the host grants only read-only host info", async () => {
  const cap = JSON.parse(await read("src-tauri/capabilities/main.json"));
  assert.deepEqual(cap.permissions, ["allow-awai-host-info"]);
  assert.match(await read("src-tauri/Cargo.toml"), /tauri = \{ version = "=3\.0\.0-alpha\.6"/);
});

test("release.json pins every shipped file", async () => {
  const rel = JSON.parse(await read("dist/release.json"));
  for (const [name, digest] of Object.entries(rel.files)) {
    assert.equal(createHash("sha256").update(await readFile(resolve(root, "dist", name))).digest("hex"), digest, name);
  }
  assert.ok(rel.files["domain.js"]);
});

test("every action's example runs in the compiled domain", async () => {
  const ctx = vm.createContext({ console });
  ctx.globalThis = ctx;
  vm.runInContext(await read("dist/domain.js"), ctx, { filename: "domain.js" });
  const api = ctx.itonami.app.run;
  const actions = Array.from(api.actions());
  assert.ok(actions.length > 0);
  for (const a of actions) {
    const r = api.run(a.name, a.example);
    assert.equal(typeof r.edn, "string", a.name);
    assert.ok(r.edn.length > 0, a.name);
  }
});
