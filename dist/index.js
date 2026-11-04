// src/client.ts
import { createData } from "@dha-team/arbundles/web";

// src/wire.ts
import { deepHash, serializeTags } from "@dha-team/arbundles/web";

// src/errors.ts
var AoHttpError = class extends Error {
  constructor(status, method, path, body) {
    super(`${method} ${path} -> ${status}: ${body.replace(/\s+/g, " ").slice(0, 300)}`);
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.name = "AoHttpError";
  }
  status;
  method;
  path;
  body;
};
var AoNotFoundError = class extends Error {
  constructor(path) {
    super(`ao-client: not found: ${path}`);
    this.path = path;
    this.name = "AoNotFoundError";
  }
  path;
};
var AoValidationError = class extends Error {
  constructor(message) {
    super(`ao-client: ${message}`);
    this.name = "AoValidationError";
  }
};
var AoContractError = class extends Error {
  constructor(reason, processId, slot, action) {
    super(`ao-client: contract rejected ${action ?? "message"} at slot ${slot}: ${reason}`);
    this.reason = reason;
    this.processId = processId;
    this.slot = slot;
    this.action = action;
    this.name = "AoContractError";
  }
  reason;
  processId;
  slot;
  action;
};
var isRetryable = (e) => {
  if (e instanceof AoValidationError) return false;
  if (e instanceof AoNotFoundError) return false;
  if (e instanceof AoContractError) return false;
  if (e instanceof AoHttpError) return e.status >= 500 || e.status === 429;
  return true;
};

// src/wire.ts
var enc = new TextEncoder();
var toBytes = (v) => typeof v === "string" ? enc.encode(v) : v;
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
function base64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : globalThis.Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(data) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}
var leBytes = (n, width) => {
  const b = new Uint8Array(width);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
var ZERO_512 = new Uint8Array(512);
async function unsignedItem(tags, data) {
  const dataBytes = toBytes(data);
  const tagsBytes = new Uint8Array(serializeTags(tags));
  const raw = concat(
    new Uint8Array([1, 0]),
    // signature type 1 (rsa), little-endian
    ZERO_512,
    // signature (zeroed)
    ZERO_512,
    // owner (zeroed)
    new Uint8Array([0]),
    // no target
    new Uint8Array([0]),
    // no anchor
    leBytes(tags.length, 8),
    leBytes(tagsBytes.length, 8),
    tagsBytes,
    dataBytes
  );
  const segment = await deepHash([
    enc.encode("dataitem"),
    enc.encode("1"),
    enc.encode("1"),
    // signature type, as a string
    ZERO_512,
    // owner forced to default for the unsigned id
    new Uint8Array(0),
    // target
    new Uint8Array(0),
    // anchor
    tagsBytes,
    dataBytes
  ]);
  return { raw, id: await sha256(new Uint8Array(segment)) };
}
async function encodeMapBundle(children) {
  const entries = await Promise.all(
    Object.entries(children).map(async ([key, child]) => [key, await unsignedItem(child.tags, child.data)])
  );
  const manifestJson = JSON.stringify(
    Object.fromEntries(entries.map(([key, item]) => [key, base64url(item.id)]))
  );
  const manifest = await unsignedItem(
    [
      { name: "data-protocol", value: "bundle-map" },
      { name: "variant", value: "0.0.1" }
    ],
    manifestJson
  );
  const items = [manifest, ...entries.map(([, item]) => item)];
  const data = concat(
    leBytes(items.length, 32),
    ...items.map((item) => concat(leBytes(item.raw.length, 32), item.id)),
    ...items.map((item) => item.raw)
  );
  return {
    data,
    bundleTags: [
      { name: "bundle-format", value: "binary" },
      { name: "bundle-version", value: "2.0.0" },
      { name: "bundle-map", value: base64url(manifest.id) }
    ]
  };
}
async function moduleIdFor(luaSource) {
  const item = await unsignedItem(
    [{ name: "content-type", value: "application/lua" }],
    luaSource
  );
  return base64url(item.id);
}
function assertTagsWellFormed(tags) {
  const seen = /* @__PURE__ */ new Set();
  for (const { name } of tags) {
    if (name !== name.toLowerCase()) {
      throw new AoValidationError(
        `tag name must be lowercase for the ans104 round-trip: "${name}"`
      );
    }
    if (name.includes("/")) {
      throw new AoValidationError(
        `tag name must not be path-flattened (re-verification throws missing_committed_key on later reads): "${name}"`
      );
    }
    if (seen.has(name)) throw new AoValidationError(`duplicate tag name: "${name}"`);
    seen.add(name);
  }
}

// src/client.ts
var ANS104_HEADERS = {
  "Content-Type": "application/ans104",
  "codec-device": "ans104@1.0"
};
function requireUrl(config) {
  if (!config.url) {
    throw new AoValidationError(
      "`url` is required and has no default. Point it at our own node (HB_URL). Falling back to a public endpoint is the failure mode this package exists to prevent."
    );
  }
  return config.url.replace(/\/+$/, "");
}
function requireSigner(config) {
  if (!config.signer) {
    throw new AoValidationError("a `signer` is required for writes (spawn/send).");
  }
}
async function withRetry(config, label, fn) {
  const attempts = Math.max(1, config.retries ?? 3);
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts || !isRetryable(e)) break;
      const backoff = 250 * 2 ** (i - 1);
      config.logger?.warn?.(
        `ao-client: ${label} failed (attempt ${i}/${attempts}), retrying in ${backoff}ms`,
        e instanceof Error ? e.message : e
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}
async function request(config, method, path, init) {
  const url = requireUrl(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 6e4);
  try {
    const res = await fetch(`${url}${path}`, {
      method,
      redirect: "follow",
      signal: controller.signal,
      ...init
    });
    const body = await res.text();
    if (!res.ok) throw new AoHttpError(res.status, method, path, body);
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}
async function postAns104(config, path, opts) {
  assertTagsWellFormed(opts.tags);
  const item = createData(opts.data, config.signer, {
    tags: opts.tags,
    ...opts.target ? { target: opts.target } : {},
    ...opts.anchor ? { anchor: opts.anchor } : {}
  });
  await item.sign(config.signer);
  const { res, body } = await request(config, "POST", path, {
    headers: ANS104_HEADERS,
    body: item.getRaw()
  });
  return { id: item.id, res, body };
}
async function fetchNodeAddress(config) {
  const { body } = await request(config, "GET", "/~meta@1.0/info/address");
  return body.trim();
}
async function spawnProcess(config, opts) {
  requireSigner(config);
  if (!opts.moduleId === !opts.luaSource) {
    throw new AoValidationError("exactly one of `moduleId` or `luaSource` is required");
  }
  if (opts.luaSource && opts.data) {
    throw new AoValidationError(
      "`data` cannot be combined with `luaSource`: the inline module occupies the data field, so the spawn data would be discarded. Publish the module and spawn by `moduleId`."
    );
  }
  const schedulerLocation = opts.schedulerLocation ?? await fetchNodeAddress(config);
  const processTags = [
    { name: "device", value: "process@1.0" },
    { name: "type", value: "Process" },
    { name: "scheduler-device", value: "scheduler@1.0" },
    { name: "execution-device", value: "lua@5.3a" },
    { name: "push-device", value: "push@1.0" },
    { name: "scheduler-location", value: schedulerLocation },
    { name: "authority", value: opts.authority ?? schedulerLocation },
    { name: "data-protocol", value: "ao" },
    { name: "variant", value: "ao.N.1" },
    ...opts.moduleId ? [{ name: "module", value: opts.moduleId }] : [],
    ...opts.tags ?? []
  ];
  let tags = processTags;
  let data = opts.data ? toBytes(opts.data) : new Uint8Array(0);
  if (opts.luaSource) {
    const bundle = await encodeMapBundle({
      module: {
        tags: [{ name: "content-type", value: "application/lua" }],
        data: opts.luaSource
      }
    });
    tags = [...bundle.bundleTags, ...processTags];
    data = bundle.data;
  }
  const { id, res } = await postAns104(config, "/~scheduler@1.0/schedule", { tags, data });
  const processId = res.headers.get("process") ?? id;
  if (opts.verify !== false) {
    await forceFirstCompute(
      config,
      processId,
      { attempts: opts.verifyAttempts, delayMs: opts.verifyDelayMs }
    );
  }
  return { processId, slot: res.headers.get("slot") };
}
async function forceFirstCompute(config, processId, opts = {}) {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 500;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return (await readRaw(config, processId, "now/at-slot")).trim();
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `ao-client: spawned ${processId} but it never computed after ${attempts} attempts (last: ${String(last?.message ?? last).slice(0, 200)})`
  );
}
async function sendMessage(config, opts) {
  requireSigner(config);
  if (!opts.processId) throw new AoValidationError("`processId` is required");
  const tags = [
    { name: "type", value: "Message" },
    { name: "data-protocol", value: "ao" },
    { name: "variant", value: "ao.N.1" },
    { name: "require-codec", value: "application/json" },
    ...opts.action ? [{ name: "action", value: opts.action }] : [],
    ...opts.tags ?? []
  ];
  const anchor = base64url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
  const sent = await withRetry(config, `send ${opts.action ?? "message"}`, async () => {
    const { id, res, body } = await postAns104(
      config,
      `/${opts.processId}~process@1.0/push`,
      { tags, data: opts.data ?? "", target: opts.processId, anchor }
    );
    let slot = res.headers.get("slot");
    if (slot === null) {
      try {
        slot = String(JSON.parse(body).slot);
      } catch {
      }
    }
    return { id, slot, body };
  });
  if (opts.confirm === false) return sent;
  if (sent.slot === null) {
    config.logger?.warn?.(
      `ao-client: node returned no slot for ${opts.action ?? "message"}; cannot confirm the contract accepted it. Treating as sent.`
    );
    return sent;
  }
  let output = (await readSlotOutput(config, opts.processId, sent.slot)).trim();
  const first = DUPLICATE.exec(output)?.[1];
  if (first !== void 0) {
    sent.slot = first;
    output = (await readSlotOutput(config, opts.processId, first)).trim();
  }
  const reason = parseContractError(output);
  if (reason !== null) {
    throw new AoContractError(reason, opts.processId, sent.slot, opts.action);
  }
  return { ...sent, output };
}
var DUPLICATE = /^error:\s*duplicate message \(slot (\d+)\)$/i;
function parseContractError(output) {
  return /^error:\s*/i.test(output) ? output.replace(/^error:\s*/i, "") : null;
}
async function readRaw(config, processId, path) {
  const clean = path.replace(/^\/+/, "");
  try {
    const { body } = await request(config, "GET", `/${processId}~process@1.0/${clean}`);
    return body;
  } catch (e) {
    if (e instanceof AoHttpError && e.status === 404) {
      throw new AoNotFoundError(`${processId}/${clean}`);
    }
    throw e;
  }
}
async function readView(config, processId, name, params) {
  const query = params && Object.keys(params).length ? "?" + new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString() : "";
  return withRetry(config, `read view ${name}`, async () => {
    const body = await readRaw(config, processId, `as/${name}${query}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(
        `ao-client: view "${name}" did not return JSON (got ${body.slice(0, 120)}). A view name that collides with a HyperBEAM process key is shadowed on the read path and returns the base value instead \u2014 check the view name.`
      );
    }
  });
}
async function materialize(config, processId, opts = {}) {
  const attempts = opts.attempts ?? 30;
  const delayMs = opts.delayMs ?? 1e3;
  let last = null;
  for (let i = 0; i < attempts; i++) {
    await forceFirstCompute(config, processId, { attempts: 1 }).catch(() => "");
    try {
      const status = await readView(config, processId, "status");
      last = status;
      if (status?.initialized !== false) return status;
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `ao-client: ${processId} did not materialize after ${attempts} attempts (last: ${JSON.stringify(last)?.slice(0, 200)})`
  );
}
function readSlotOutput(config, processId, slot) {
  return withRetry(config, `read slot ${slot}`, () => readRaw(config, processId, `compute&slot=${slot}/results/output/data`));
}

// src/index.ts
function createAoClient(config) {
  return {
    config,
    fetchNodeAddress: () => fetchNodeAddress(config),
    spawnProcess: (opts) => spawnProcess(config, opts),
    sendMessage: (opts) => sendMessage(config, opts),
    readView: (processId, name, params) => readView(config, processId, name, params),
    readSlotOutput: (processId, slot) => readSlotOutput(config, processId, slot),
    materialize: (processId, opts) => materialize(config, processId, opts),
    readRaw: (processId, path) => readRaw(config, processId, path)
  };
}
function nodeUrlFromEnv(env = process.env, varName = "HB_URL") {
  const url = env[varName]?.trim();
  if (!url) {
    throw new AoValidationError(
      `${varName} is not set. It must point at our HyperBEAM node (e.g. https://hb.anyone.tech). There is deliberately no default.`
    );
  }
  if (!/^https?:\/\//.test(url)) {
    throw new AoValidationError(`${varName} must be an absolute http(s) URL, got "${url}"`);
  }
  return url;
}
export {
  AoContractError,
  AoHttpError,
  AoNotFoundError,
  AoValidationError,
  createAoClient,
  fetchNodeAddress,
  isRetryable,
  materialize,
  moduleIdFor,
  nodeUrlFromEnv,
  readRaw,
  readSlotOutput,
  readView,
  sendMessage,
  spawnProcess
};
//# sourceMappingURL=index.js.map