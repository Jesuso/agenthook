// A real, throwaway OpenSSH client+server pair for test/dispatch-executor-ssh-real.test.js (#861):
// every other ssh test in this repo runs against the fake `ssh` in test/_ssh-helpers.js, so none
// of them can tell whether executor-ssh.js's assumptions about real OpenSSH still hold. This file
// is NOT matched by the `test/*.test.js` glob `npm test` runs, so it is never itself run as a test.
//
// Never touches `~/.ssh` or the system sshd: everything (host/client keys, known_hosts, configs,
// the server's state) lives under one mkdtemp dir, and the daemon only binds 127.0.0.1.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";

/** @returns {string|undefined} the first of these found on PATH, else in the given absolute dirs. */
function findBin(name, extraDirs) {
  try {
    const p = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    if (p) return p;
  } catch {
    /* not on PATH */
  }
  for (const dir of extraDirs) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** A free high TCP port on 127.0.0.1, found by binding :0 and reading what the kernel picked.
 * @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/** Poll `ssh -F <sshConfig> -i <identityFile> -p <port> 127.0.0.1 true` until it succeeds or
 * `deadline` passes. Without `-i`/`IdentitiesOnly`, the probe would fall back to the operator's
 * own `~/.ssh` default identities instead of the throwaway client key. @returns
 * {Promise<{ok: boolean, lastErr?: string}>} */
async function waitUntilReady(realSsh, sshConfig, port, identityFile, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      execFileSync(realSsh, ["-F", sshConfig, "-i", identityFile, "-T", "-o", "BatchMode=yes", "-p", String(port), "127.0.0.1", "true"], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 2000,
      });
      return { ok: true };
    } catch (e) {
      lastErr = (e.stderr || e.message || e).toString();
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { ok: false, lastErr };
}

/**
 * Start a throwaway sshd on 127.0.0.1 plus a client-side `ssh` wrapper placed first on `PATH`
 * (the harness has no known-hosts/ssh_config knob, so every call site that resolves `ssh` off
 * `PATH` — runRemote/runRemoteChecked/archiveToWorker/the launcher/GIT_SSH_COMMAND — picks up the
 * wrapper transparently). Missing `sshd`/`ssh`/`ssh-keygen`, or a daemon that never becomes ready,
 * resolves to `{available: false, reason}` — callers must `t.skip(reason)`, never fail, on that.
 * @returns {Promise<{available: false, reason: string}|{available: true, port: number, host: string,
 *   identityFile: string, wrongIdentityFile: string, binDir: string, tmp: string,
 *   rotateHostKey: () => void, restoreHostKey: () => void, stop: () => Promise<void>}>}
 */
export async function startThrowawaySshd() {
  const realSsh = findBin("ssh", []);
  const sshKeygen = findBin("ssh-keygen", []);
  const sshd = findBin("sshd", ["/usr/sbin", "/usr/local/sbin"]);
  if (!realSsh || !sshKeygen) return { available: false, reason: "ssh/ssh-keygen not found on PATH" };
  if (!sshd) return { available: false, reason: "sshd not found on PATH, /usr/sbin or /usr/local/sbin" };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ah-sshd-"));
  const hostKey = path.join(tmp, "host_ed25519");
  const clientKey = path.join(tmp, "client_ed25519");
  const wrongClientKey = path.join(tmp, "wrong_ed25519");
  const authorizedKeys = path.join(tmp, "authorized_keys");
  const knownHosts = path.join(tmp, "known_hosts");
  const sshdConfig = path.join(tmp, "sshd_config");
  const sshConfig = path.join(tmp, "ssh_config");
  const pidFile = path.join(tmp, "sshd.pid");
  const binDir = path.join(tmp, "bin");

  let port;
  try {
    port = await freePort();
    execFileSync(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    execFileSync(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
    execFileSync(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", wrongClientKey]);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return { available: false, reason: `key generation failed: ${(e.stderr || e.message || e).toString().trim()}` };
  }
  fs.writeFileSync(authorizedKeys, fs.readFileSync(`${clientKey}.pub`, "utf8"), { mode: 0o600 });
  fs.writeFileSync(knownHosts, hostKnownHostsLine(hostKey, port), { mode: 0o600 });

  const baseConfigLines = [
    "ListenAddress 127.0.0.1",
    `Port ${port}`,
    `HostKey ${hostKey}`,
    "UsePAM no",
    "StrictModes no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PubkeyAuthentication yes",
    `AuthorizedKeysFile ${authorizedKeys}`,
    `PidFile ${pidFile}`,
  ];
  // OpenSSH >= 9.8's PerSourcePenalties (on by default) temporarily drops connections from a
  // source after an auth failure or a no-auth disconnect (exactly what A4's wrong-key and A8/A9's
  // short-lived probe connections trigger), which would otherwise reset the NEXT test's connection
  // with no relation to what that test is actually checking. Disabling it needs an older-sshd
  // fallback: an sshd that doesn't know the keyword rejects the whole config, so probe first with
  // `-t` against a throwaway file and only add the line if that succeeds.
  const probeConfig = path.join(tmp, "sshd_config.probe");
  fs.writeFileSync(probeConfig, [...baseConfigLines, "PerSourcePenalties no", ""].join("\n"));
  let supportsPerSourcePenalties = false;
  try {
    execFileSync(sshd, ["-t", "-f", probeConfig], { stdio: ["ignore", "ignore", "pipe"] });
    supportsPerSourcePenalties = true;
  } catch {
    /* older sshd: leave PerSourcePenalties at its (pre-9.8) absent default */
  }
  fs.rmSync(probeConfig, { force: true });

  fs.writeFileSync(sshdConfig, [...baseConfigLines, ...(supportsPerSourcePenalties ? ["PerSourcePenalties no"] : []), ""].join("\n"));
  fs.writeFileSync(
    sshConfig,
    ["UserKnownHostsFile " + knownHosts, "StrictHostKeyChecking yes", "GlobalKnownHostsFile /dev/null", "IdentitiesOnly yes", "IdentityAgent none", "CheckHostIP no", ""].join("\n"),
  );

  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "ssh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shArg(realSsh)} -F ${shArg(sshConfig)} "$@"\n`, { mode: 0o755 });

  let stderrBuf = "";
  const proc = spawn(sshd, ["-D", "-e", "-f", sshdConfig], { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr.on("data", (d) => {
    stderrBuf += d;
  });
  let exited = false;
  proc.on("exit", () => {
    exited = true;
  });

  const ready = await waitUntilReady(realSsh, sshConfig, port, clientKey, 5000);
  if (!ready.ok || exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    // sshd's own `-e` diagnostics (why it dropped/refused the connection) are more useful than
    // the client's generic error, so lead with those; keep the client error too in case sshd
    // printed nothing (e.g. it never started at all).
    const sshdTail = stderrBuf.trim();
    const clientErr = (ready.lastErr || "").trim();
    const reason = [sshdTail && `sshd: ${sshdTail}`, clientErr && `client: ${clientErr}`].filter(Boolean).join("; ") || "(no diagnostics)";
    return { available: false, reason: `sshd never became ready: ${reason}` };
  }

  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    process.env.PATH = savedPath;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 2000;
    while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (!exited) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  /** Replace known_hosts with a DIFFERENT host key for the same [127.0.0.1]:port (A5): sshd keeps
   * running with its original host key, so the client now sees a mismatch — exactly what a real
   * host-key rotation looks like from the client's side, without restarting the daemon. */
  const rotateHostKey = () => {
    const otherKey = path.join(tmp, "other_host_ed25519");
    if (!fs.existsSync(`${otherKey}.pub`)) execFileSync(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", otherKey]);
    fs.writeFileSync(knownHosts, hostKnownHostsLine(otherKey, port), { mode: 0o600 });
  };

  /** Undo `rotateHostKey()`: put the server's real host key back in known_hosts so every test
   * after A5 connects normally — without this, A5 permanently breaks host-key verification for
   * the rest of the file. */
  const restoreHostKey = () => {
    fs.writeFileSync(knownHosts, hostKnownHostsLine(hostKey, port), { mode: 0o600 });
  };

  return {
    available: true,
    port,
    host: "127.0.0.1",
    identityFile: clientKey,
    wrongIdentityFile: wrongClientKey,
    binDir,
    tmp,
    rotateHostKey,
    restoreHostKey,
    stop,
  };
}

/** `known_hosts` line for `[127.0.0.1]:<port>` from a `ssh-keygen -f <keyPath>`-generated keypair's
 * public half. @param {string} keyPath @param {number} port @returns {string} */
function hostKnownHostsLine(keyPath, port) {
  const pub = fs.readFileSync(`${keyPath}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  return `[127.0.0.1]:${port} ${pub}\n`;
}

/** POSIX single-quote for the wrapper script's embedded real-ssh path. @param {string} s */
function shArg(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
