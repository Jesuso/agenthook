// Loopback port probes shared by `doctor` (is the profile's port free?) and `init --local`
// (pick the first free one).
import net from "node:net";

/** Is a TCP port already bound on 127.0.0.1? @param {number} port @returns {Promise<boolean>} */
export function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

/**
 * The first port from `from` upward that nothing listens on (at most `tries` probes).
 * @param {number} from @param {{tries?: number, inUse?: (port: number) => Promise<boolean>}} [opts]
 * @returns {Promise<number>}
 */
export async function firstFreePort(from, { tries = 100, inUse = portInUse } = {}) {
  for (let p = from; p < from + tries; p++) if (!(await inUse(p))) return p;
  throw new Error(`no free port in ${from}–${from + tries - 1}`);
}
