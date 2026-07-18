// StorageProvider contract (plan §5). ALL user-data persistence goes through
// an object with this shape — main.js must never touch fs for user data.
// The future "better storage" (SQLite, server, …) is a new implementation of
// this same contract; nothing above it changes.
//
// @typedef {Object} StorageProvider
// @property {() => Promise<object>} load               validated doc; throws {code:'CORRUPT'} on bad file
// @property {(doc: object) => Promise<void>} save      ATOMIC write + snapshot + prune
// @property {(doc: object) => void} saveSync           synchronous flush for quit
// @property {() => Promise<{id,timeISO,bytes}[]>} listSnapshots   newest first
// @property {(id: string) => Promise<object>} loadSnapshot
// @property {() => Promise<void>} snapshotNow
// @property {() => string|null} lastSavedContent       for self-write detection by the watcher

const { JsonProvider } = require('./json-provider');

/** @returns {JsonProvider} the v1 provider (plan §2: JSON + snapshots) */
function createProvider(dataDir, opts) {
  return new JsonProvider(dataDir, opts);
}

module.exports = { createProvider };
