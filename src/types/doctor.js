/** A check's remedy: a safe local fix (`describe` is its `--dry-run` text) or the manual
 * action for a problem that is never auto-fixed. Only ✗/⚠ checks carry one.
 * @typedef {{ describe: string, apply: () => void|Promise<void> } | { manual: string }} Fix */
/** @typedef {{ ok: boolean, warn?: boolean, info?: boolean, label: string, note?: string, fix?: Fix }} Check */

export {};
