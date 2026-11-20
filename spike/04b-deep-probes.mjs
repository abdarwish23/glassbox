// 04b — Deep probes: establish ground truth on the ambiguous 04 results.
//  - /proc/self/environ read (04's attempt had a harness bug — it never opened the file)
//  - os.system: does it really execute on the HOST? (host-side marker file check)
//  - socket: can Python exchange real bytes with a host-loopback TCP server?
//  - js.fetch: can Python drive the host's fetch() to reach a host-loopback HTTP server?
// Run: node 04b-deep-probes.mjs
import { writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";

const CANARY = "CANARY_TEST_VALUE_9f3k2";
process.env.GLASSBOX_CANARY = CANARY;

const MARKER = "/tmp/glassbox_ossystem_host_marker";
const IDOUT = "/tmp/glassbox_id_out.txt";
for (const f of [MARKER, IDOUT]) if (fs.existsSync(f)) fs.unlinkSync(f);

// Host-loopback TCP server that speaks a canary payload
const tcpServer = net.createServer((sock) => {
  sock.write("TCP_CANARY_HELLO");
  sock.on("data", () => {});
});
await new Promise((r) => tcpServer.listen(18711, "127.0.0.1", r));

// Host-loopback HTTP server
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ canary: "HTTP_CANARY_7d2e" }));
});
await new Promise((r) => httpServer.listen(18712, "127.0.0.1", r));

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas"]);

function attempt(code) {
  const wrapped = `
import json
try:
    _r = (lambda: (${code}))()
    _out = json.dumps(_r)
except Exception as e:
    _out = json.dumps({"outcome": "blocked", "detail": type(e).__name__ + ": " + str(e)[:220]})
_out
`;
  const out = String(pyodide.runPython(wrapped)).trim().split("\n").pop();
  try {
    return JSON.parse(out);
  } catch {
    return { outcome: "error", detail: "unparseable: " + out.slice(0, 200) };
  }
}

const attempts = {};

// FIXED /proc attempt — actually opens and reads the file this time
attempts.proc_environ_read = attempt(`(lambda: (
    (lambda data: {"outcome": "SUCCEEDED" if "${CANARY}" in data else "partial",
                    "detail": "read /proc/self/environ, " + str(len(data)) + " bytes, canary inside: " + str("${CANARY}" in data)})(
        open("/proc/self/environ", "rb").read().decode("utf-8", "replace"))
))()`);

// os.system with a host-observable side effect
attempts.os_system_touch = attempt(`(lambda: (
    (lambda rc: {"outcome": "ran", "detail": "os.system('touch ${MARKER}') rc=" + repr(rc)})(
        __import__("os").system("touch ${MARKER}"))
))()`);
attempts.os_system_id = attempt(`(lambda: (
    (lambda rc: {"outcome": "ran", "detail": "os.system('id > ${IDOUT}') rc=" + repr(rc)})(
        __import__("os").system("id > ${IDOUT}"))
))()`);

// Real socket data exchange with the host-loopback TCP server
attempts.socket_loopback_exchange = attempt(`(lambda: (
    (lambda s: (
        s[0].settimeout(4),
        s[0].sendall(b"ping-from-python"),
        (lambda data: {"outcome": "SUCCEEDED" if b"TCP_CANARY_HELLO" in data else "partial",
                        "detail": "received from host loopback server: " + repr(data)})(s[0].recv(64))
    )[2])([__import__("socket").create_connection(("127.0.0.1", 18711), timeout=4)])
))()`);

// js.fetch driven from Python (async) against the host-loopback HTTP server
let jsFetch;
try {
  pyodide.runPython(`
import js
async def _fetch_test():
    r = await js.fetch("http://127.0.0.1:18712/")
    return await r.text()
`);
  const text = await pyodide.runPythonAsync("_fetch_test()");
  jsFetch = {
    outcome: String(text).includes("HTTP_CANARY_7d2e") ? "SUCCEEDED" : "partial",
    detail: "js.fetch from Python returned: " + String(text).slice(0, 80),
  };
} catch (e) {
  jsFetch = { outcome: "blocked", detail: String(e).slice(0, 220) };
}
attempts.js_fetch_loopback_http = jsFetch;

tcpServer.close();
httpServer.close();

writeResult("logs/04b-deep-probes.json", {
  test: "04b-deep-probes",
  attempts,
  host_checks: {
    os_system_created_host_marker: fs.existsSync(MARKER),
    os_system_id_output_on_host: fs.existsSync(IDOUT)
      ? fs.readFileSync(IDOUT, "utf8").trim().slice(0, 120)
      : null,
  },
});
