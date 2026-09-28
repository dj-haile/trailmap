// Text for the "Where Is My Data…" dialog and the launch-time data notices.
// Pure: no Electron import, so unit tests and e2e specs can compute the exact
// strings the app shows. Paths are passed through verbatim — native dialogs
// render plain text, and a user must be able to copy what they see.

/** Button indices for the data-info dialog (order matches dataInfoButtons). */
const BUTTONS = { OK: 0, COPY: 1, REVEAL: 2, BACKUP: 3, HISTORY: 4 };

function dataInfoButtons(platform = process.platform) {
  const reveal = platform === 'darwin' ? 'Reveal in Finder' : 'Show in Folder';
  return ['OK', 'Copy Path', reveal, 'Back Up…', 'Snapshot History…'];
}

/** Local date and time to the second; 'never' when there is no timestamp. */
function formatWhen(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/**
 * @param {{ file: string, exists: boolean, snapDir: string, savedAtISO: string|null,
 *           snapshotCount: number, newestSnapshotISO: string|null, override: boolean }} info
 * @returns {{ message: string, detail: string }} message is the bold headline (the path lives there)
 */
function formatDataInfo(info) {
  const message = `Your map is stored at\n${info.file}`;
  const lines = [];
  if (info.exists) {
    lines.push(`Last saved: ${formatWhen(info.savedAtISO)}`);
  } else {
    lines.push('The file is not on disk right now. Your map is still open here and the next edit recreates the file.');
  }
  lines.push('', 'Snapshots folder:', info.snapDir);
  const n = info.snapshotCount;
  lines.push(n === 0
    ? 'No snapshots yet'
    : `${n} snapshot${n === 1 ? '' : 's'}, newest ${formatWhen(info.newestSnapshotISO)}`);
  lines.push('',
    'Every save writes the file atomically and adds a snapshot. Quitting saves first.',
    'A force-quit can lose at most the last half second of typing.');
  if (info.override) lines.push('', 'Location set by TRAILMAP_DATA_DIR.');
  return { message, detail: lines.join('\n') };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Launch found no live file but snapshots exist beside it: ask before starting blank. */
function missingFileMessage(file, snapshotCount, newestISO) {
  return {
    type: 'question',
    message: 'Trailmap could not find your data file',
    detail: `Nothing is at:\n${file}\n\n` +
            `But ${plural(snapshotCount, 'snapshot')} of your map exist next to it, the newest from ` +
            `${formatWhen(newestISO)}. Restore the newest one, or start with an empty map?`,
    buttons: ['Restore newest snapshot', 'Start empty'],
    defaultId: 0,
    cancelId: 1,
  };
}

/** The user chose to restore, but no snapshot could be read. */
function snapshotsUnreadableMessage(snapDir, count) {
  return {
    type: 'warning',
    message: 'Trailmap could not restore a snapshot',
    detail: `None of the ${plural(count, 'snapshot')} in:\n${snapDir}\ncould be read. Starting with an empty map.`,
  };
}

/** Corrupt live file and no readable snapshot. Says "empty map" because that is what loads. */
function recoveryFailedMessage(badPath) {
  return {
    type: 'warning',
    message: 'Trailmap could not recover your data',
    detail: `The data file was unreadable and no valid snapshot existed. ` +
            `The bad file was kept at:\n${badPath}\n\nStarting with an empty map.`,
  };
}

module.exports = {
  BUTTONS, dataInfoButtons, formatDataInfo, formatWhen,
  missingFileMessage, snapshotsUnreadableMessage, recoveryFailedMessage,
};
