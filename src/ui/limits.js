// `ah ui` file-size limits (docs/web-ui.md § v2, § v3).

/** Largest file either editor reads or writes (and the PUT body cap). */
export const UI_MAX_BYTES = 256 * 1024;
