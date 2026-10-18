// Types only (no runtime code): the per-createEngine mutable state the src/engine/ factories
// share. One object per engine — the exit paths, boot and the controllers' lock checks all
// read and write it instead of closure locals.

/**
 * @typedef {object} EngineState
 * @property {boolean} draining  a shutdown is in progress (a second signal force-kills)
 * @property {boolean} respawnOnExit  set by a firing restart; any signal clears it
 * @property {string|undefined} moveOnExit  the restart's state-dir move target, if any
 * @property {boolean} archiveOnExit  set by a firing decommission; any signal clears it
 * @property {boolean} finished  teardown's respawn/archive tail runs once
 * @property {{close(): void} | null} control  the control socket, once boot started it
 * @property {import('node:http').Server} server  the webhook listener
 */

export {};
