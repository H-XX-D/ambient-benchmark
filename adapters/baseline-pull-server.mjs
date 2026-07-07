#!/usr/bin/env node
// HTTP wrapper for the floor baseline adapter. This exposes the same AMBIENT
// wire protocol as adapters/recall_adapter.mjs, so the runner can drive a
// non-Recall system through --adapter-url instead of relying on in-process
// imports.

import { createServer } from "node:http";
import { BaselinePull } from "./baseline-pull.mjs";

const NAME = "baseline-pull";
const stores = new Map();

function getStore(name = "default") {
  if (!stores.has(name)) stores.set(name, new BaselinePull());
  return stores.get(name);
}

function resetStore(name) {
  stores.set(name, new BaselinePull());
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res, body, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const routes = {
  name: async () => ({ name: NAME }),
  reset: async (b) => {
    const name = b?.store;
    if (!name || name === "all") {
      stores.clear();
      return { ok: true, reset: "all" };
    }
    resetStore(name);
    return { ok: true, reset: name };
  },
  setAutoCapture: async (b) => ({ supported: true, auto: Boolean(b?.enabled) }),
  write: async (b) => getStore(b?.store).write(b?.fact ?? "", b?.source ?? "ingest"),
  query: async (b) => getStore(b?.store).query(b?.question ?? "", b?.top_k || 8),
  surface: async () => ({ supported: false }),
  dag: async () => ({ supported: false, isDag: null, cycles: [] }),
  collection: async () => ({ supported: false, size: 0 }),
};

const server = createServer(async (req, res) => {
  const path = (req.url || "").replace(/^\//, "").split("?")[0];
  if (req.method === "GET" && path === "name") return send(res, await routes.name());
  if (req.method !== "POST" || !routes[path]) return send(res, { error: "not found" }, 404);
  try {
    const body = await readBody(req);
    return send(res, await routes[path](body));
  } catch (e) {
    return send(res, { error: String(e?.message || e) }, 500);
  }
});

const portFlag = process.argv.indexOf("--port");
const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : 8091);
server.listen(port, "127.0.0.1", () => {
  console.log(`${NAME} adapter on 127.0.0.1:${port}`);
});
