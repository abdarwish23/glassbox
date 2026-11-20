// 04 — Hostile-code tests: can agent Python escape the Pyodide sandbox?
// Attempts: env read, host file read/write, network, subprocess, JS-bridge escapes.
// A canary secret is planted in the NODE process env; Python must never obtain it.
// Run: node 04-hostile-test.mjs
import { writeResult } from "./lib.mjs";
import { loadPyodide } from "pyodide";
import fs from "node:fs";

const CANARY = "CANARY_TEST_VALUE_9f3k2";
process.env.GLASSBOX_CANARY = CANARY;
const HOST_PWN_PATH = "/tmp/glassbox_pwned.txt";
if (fs.existsSync(HOST_PWN_PATH)) fs.unlinkSync(HOST_PWN_PATH);

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas"]);

// Each attempt runs in Python and reports {outcome, detail} as JSON.
// outcome: "blocked" (escape failed) | "SUCCEEDED" (escape worked) | "partial"
function attempt(code) {
  const wrapped = `
import json, traceback
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

// 1. Read the host process environment
attempts.env_read = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED" if v == "${CANARY}" else "blocked",
                 "detail": "os.getenv(GLASSBOX_CANARY) -> " + repr(v)})(__import__("os").getenv("GLASSBOX_CANARY"))
))()`);

attempts.env_listing = attempt(`(lambda: (
    (lambda ks: {"outcome": "SUCCEEDED" if "GLASSBOX_CANARY" in ks else "blocked",
                  "detail": "os.environ keys visible to Python: " + repr(ks[:12])})(list(__import__("os").environ.keys()))
))()`);

// 2. Read host files
attempts.file_read_etc_passwd = attempt(`(lambda: (
    {"outcome": "SUCCEEDED", "detail": "read /etc/passwd: " + open("/etc/passwd").read()[:40]}
))()`);
attempts.file_read_design_doc = attempt(`(lambda: (
    {"outcome": "SUCCEEDED", "detail": "read host DESIGN.md: " + open("/home/hatch/workspace/glassbox/DESIGN.md").read()[:40]}
))()`);
attempts.file_read_proc_environ = attempt(`(lambda: (
    {"outcome": "SUCCEEDED", "detail": "read /proc/self/environ"}
))()`);

// 3. Write a file at a host path (lands in MEMFS if isolated; Node checks the host after)
attempts.file_write_tmp = attempt(`(lambda: (
    open("/tmp/glassbox_pwned.txt", "w").write("pwned"),
    {"outcome": "partial", "detail": "python-side write+readback: " + open("/tmp/glassbox_pwned.txt").read()}
)[1])()`);

// 4. Network access
attempts.network_socket = attempt(`(lambda: (
    __import__("socket").create_connection(("1.1.1.1", 443), timeout=4),
    {"outcome": "SUCCEEDED", "detail": "TCP connect to 1.1.1.1:443 succeeded"}
)[1])()`);
attempts.network_http = attempt(`(lambda: (
    (lambda r: {"outcome": "SUCCEEDED", "detail": "HTTP status " + str(r.status)})(
        __import__("urllib.request", fromlist=["urlopen"]).urlopen("https://example.com", timeout=4))
))()`);
attempts.network_dns = attempt(`(lambda: (
    (lambda r: {"outcome": "SUCCEEDED", "detail": "DNS resolved: " + repr(r[0][4])})(
        __import__("socket").getaddrinfo("example.com", 443))
))()`);

// 5. Spawn a process / shell
attempts.os_system = attempt(`(lambda: (
    (lambda rc: {"outcome": "SUCCEEDED" if rc == 0 else "blocked",
                 "detail": "os.system('echo hi') returned " + repr(rc)})(__import__("os").system("echo hi"))
))()`);
attempts.subprocess = attempt(`(lambda: (
    (lambda r: {"outcome": "SUCCEEDED", "detail": "subprocess ran: " + repr(r.stdout)})(
        __import__("subprocess").run(["echo", "hi"], capture_output=True, text=True, timeout=4))
))()`);

// 6. JS-bridge escape attempts (Pyodide exposes host JS via the `js` module)
attempts.js_globalthis_keys = attempt(`(lambda: (
    (lambda ks: {"outcome": "info", "detail": "globalThis keys: " + repr(ks)})(
        list(__import__("js").Object.keys(__import__("js").globalThis).to_py()))
))()`);
attempts.js_process_attr = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED", "detail": "js.process obtained: " + repr(v)})(
        getattr(__import__("js"), "process"))
))()`);
attempts.js_eval_typeof_process = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED" if v == "object" else "blocked",
                 "detail": "js.eval('typeof process') -> " + repr(v)})(
        str(__import__("js").eval("typeof process")))
))()`);
attempts.js_function_canary = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED" if v == "${CANARY}" else "blocked",
                 "detail": "Function('return process.env.GLASSBOX_CANARY')() -> " + repr(v)})(
        __import__("js").Function("return process.env.GLASSBOX_CANARY")())
))()`);
attempts.js_function_require = attempt(`(lambda: (
    (lambda v: {"outcome": "SUCCEEDED" if v else "blocked",
                 "detail": "Function('return this')() has require? " + repr(v)})(
        "require" in list(__import__("js").Object.keys(__import__("js").Function("return this")()).to_py()) if hasattr(__import__("js").Function("return this")(), "Object") else False)
))()`);

const hostFileCreated = fs.existsSync(HOST_PWN_PATH);

writeResult("logs/04-hostile-test.json", {
  test: "04-hostile-test",
  canary_planted_in_node_env: true,
  attempts,
  host_checks: {
    host_tmp_file_created_by_python_write: hostFileCreated,
  },
});
