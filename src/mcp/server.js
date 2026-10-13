// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), zero dependencies — the repo
// ships unbuilt and dependency-free, and the protocol surface we need is four methods:
// initialize, ping, tools/list, tools/call. stdout carries protocol messages ONLY; anything
// human-readable goes to stderr.
//
// `handlers` is injected so the transport is testable without a process: tools/call runs
// `handlers.call(name, args, {signal})`, and a client `notifications/cancelled` aborts that
// request's signal (the long-poll `events` wait honours it).

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * @typedef {object} ToolHandlers
 * @property {() => any[]} list  tool definitions for tools/list
 * @property {(name: string, args: any, ctx: {signal: AbortSignal}) => Promise<any>} call  result object (JSON-serialised for the model); throws for isError
 */

/**
 * @param {{name: string, version: string, instructions?: string, handlers: ToolHandlers}} opts
 * @returns {{handleLine(line: string, write: (msg: object) => void): Promise<void>, closeAll(): void}}
 */
export function createMcpServer({ name, version, instructions, handlers }) {
  /** @type {Map<string|number, AbortController>} */
  const inflight = new Map();
  /** Request ids the CLIENT cancelled (MCP: those get no response). Closing stdin aborts waits too,
   * but a one-shot `printf ... | agenthook mcp` pipeline still wants its replies. @type {Set<string|number>} */
  const clientCancelled = new Set();

  /** @param {any} id @param {number} code @param {string} message */
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  /** @param {any} req @param {(m: object) => void} write */
  async function request(req, write) {
    const { id, method, params } = req;
    switch (method) {
      case "initialize": {
        const want = params?.protocolVersion;
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            ...(instructions ? { instructions } : {}),
          },
        });
        return;
      }
      case "ping":
        write({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list":
        write({ jsonrpc: "2.0", id, result: { tools: handlers.list() } });
        return;
      case "tools/call": {
        const toolName = params?.name;
        if (typeof toolName !== "string") {
          write(rpcError(id, -32602, "tools/call: name is required"));
          return;
        }
        const ac = new AbortController();
        inflight.set(id, ac);
        try {
          const result = await handlers.call(toolName, params?.arguments ?? {}, { signal: ac.signal });
          // MCP: a cancelled request gets no response.
          if (!clientCancelled.has(id)) write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
        } catch (e) {
          if (clientCancelled.has(id)) return;
          if (e?.code === "unknown_tool") write(rpcError(id, -32602, e.message));
          else write({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] } });
        } finally {
          inflight.delete(id);
          clientCancelled.delete(id);
        }
        return;
      }
      default:
        write(rpcError(id, -32601, `method not found: ${method}`));
    }
  }

  return {
    /** @param {string} line @param {(msg: object) => void} write */
    async handleLine(line, write) {
      if (!line.trim()) return;
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, "parse error"));
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") {
        if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) return; // a response to us: we send no requests
        write(rpcError(msg?.id ?? null, -32600, "invalid request"));
        return;
      }
      if (msg.id === undefined || msg.id === null) {
        // notification
        if (msg.method === "notifications/cancelled") {
          const rid = msg.params?.requestId;
          if (inflight.has(rid)) {
            clientCancelled.add(rid);
            inflight.get(rid)?.abort();
          }
        }
        return;
      }
      await request(msg, write);
    },
    /** Abort every in-flight call (stdin closed). */
    closeAll() {
      for (const ac of inflight.values()) ac.abort();
    },
  };
}

/**
 * Pump stdin→server→stdout until stdin ends. Requests run concurrently (a long `events` wait
 * must not block a `status`); replies are matched by id on the client side.
 * @param {ReturnType<typeof createMcpServer>} server
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: {write(s: string): any}}} [io]
 * @returns {Promise<void>} resolves when stdin closes and in-flight calls settle
 */
export function serveStdio(server, { stdin = process.stdin, stdout = process.stdout } = {}) {
  /** @param {object} m */
  const write = (m) => void stdout.write(JSON.stringify(m) + "\n");
  return new Promise((resolve) => {
    let buf = "";
    /** @type {Set<Promise<void>>} */
    const pending = new Set();
    stdin.setEncoding("utf8");
    stdin.on("data", (/** @type {string} */ chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const p = server.handleLine(line, write).catch((e) => console.error(`[mcp] ${e.message}`));
        pending.add(p);
        p.finally(() => pending.delete(p));
      }
    });
    stdin.on("end", () => {
      server.closeAll();
      Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
