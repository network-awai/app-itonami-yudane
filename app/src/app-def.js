// Actions come from the ClojureScript domain build (domain.js, loaded before this
// module). Each action takes EDN text and returns EDN text; every run is kept in
// the local store so the 記録 tab shows what was computed on this device.
const api = globalThis.itonami?.app?.run;
if (!api) throw new Error("domain.js did not load");
const RUNS = "itonami.app.run";

export const app = {
  title: __TITLE__,
  description: __DESCRIPTION__,
  did: __DID__,
  storageKey: __STORAGE_KEY__,
  collections: [{ name: RUNS, label: "実行の記録" }],
  actions: Array.from(api.actions(), (a) => ({
    name: a.name, label: a.label, help: a.help,
    fields: [{ name: "input", label: "入力（EDN）", type: "textarea", rows: 8, value: a.example }],
    run: async (store, input) => {
      const text = input.input ?? "";
      const { edn } = api.run(a.name, text);
      await store.write({ collection: RUNS, record: { action: a.name, input: text, output: edn, at: new Date().toISOString() } });
      return edn;
    },
  })),
};
