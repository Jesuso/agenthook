// Manual / hosted ingress: the public URL is externally managed and stable
// (a real domain behind a reverse proxy, a long-lived tunnel, port-forward, …).
// up() just hands back the configured URL; down() is a no-op. Because the URL is
// stable, ephemeral=false, so the engine skips the boot-time webhook scrub and
// relies on each tracker's idempotent registerWebhook.

/** @type {import('../types.js').IngressFactory} */
export function createManualIngress(cfg) {
  return {
    describe: () => ({ name: "manual", ephemeral: false }),

    async up() {
      const url = cfg.ingress?.url;
      if (!url) {
        throw new Error(
          `ingress "manual": set ingress.url to your public HTTPS base URL ` +
            `(the receiver listens on 127.0.0.1:${cfg.port}; point your proxy/tunnel there).`,
        );
      }
      return { url: url.replace(/\/$/, "") };
    },

    async down() {},

    wizardSteps: () => [
      {
        key: "url",
        message: "Public HTTPS base URL the tracker should call (e.g. https://hook.you.com)",
        validate: (v) => (/^https:\/\//.test(v) ? true : "must start with https://"),
      },
    ],
  };
}
