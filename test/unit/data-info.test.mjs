// "Where Is My Data…" dialog text: deterministic, paths passed through verbatim.
// Spec: thoughts/shared/specs/2026-09-26-data-file-visibility.md (AC-11)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Required lazily so a missing module fails the named test, not the file.
const di = () => require('../../electron/data-info.js');

const base = () => ({
  file: '/tmp/x/trailmap.json',
  exists: true,
  snapDir: '/tmp/x/snapshots',
  savedAtISO: '2026-09-26T17:41:20.000Z',
  snapshotCount: 16,
  newestSnapshotISO: '2026-09-26T17:41:20.000Z',
  override: false,
});

test('formatDataInfo lists the live file, snapshots folder, saved time and snapshot count', () => {
  const { formatDataInfo, formatWhen } = di();
  const { message, detail } = formatDataInfo(base());
  assert.ok(message.includes('/tmp/x/trailmap.json'), 'file path is in the headline');
  assert.ok(detail.includes('/tmp/x/snapshots'), 'snapshots folder is in the detail');
  assert.ok(detail.includes('Last saved: ' + formatWhen('2026-09-26T17:41:20.000Z')));
  assert.match(detail, /\b16 snapshots\b/);
  assert.ok(detail.includes('newest ' + formatWhen('2026-09-26T17:41:20.000Z')));
  assert.ok(!detail.includes('TRAILMAP_DATA_DIR'), 'no override line by default');
  assert.ok(formatDataInfo({ ...base(), override: true }).detail.includes('TRAILMAP_DATA_DIR'));
  const missing = formatDataInfo({ ...base(), exists: false, savedAtISO: null }).detail;
  assert.match(missing, /not on disk right now/);
  assert.ok(!missing.includes('Last saved'), 'no false "last saved" for a missing file');
});

test('dialog offers named buttons and passes the path through as plain text', () => {
  const { BUTTONS, dataInfoButtons, formatDataInfo } = di();
  const b = dataInfoButtons('darwin');
  assert.equal(b.length, 5);
  assert.equal(new Set(b).size, 5, 'button labels are distinct');
  for (const label of b) assert.ok(typeof label === 'string' && label.trim().length > 0, 'every button has a name');
  for (const i of Object.values(BUTTONS)) assert.ok(Number.isInteger(i) && i >= 0 && i < b.length);
  assert.equal(b[BUTTONS.REVEAL], 'Reveal in Finder');
  assert.equal(dataInfoButtons('linux')[BUTTONS.REVEAL], 'Show in Folder');
  const weird = '/tmp/<b>&"odd"/trailmap.json';
  assert.ok(formatDataInfo({ ...base(), file: weird }).message.includes(weird), 'path is not escaped or altered');
});
