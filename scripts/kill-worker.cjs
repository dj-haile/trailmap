// Kill-test worker: hammer saves until killed.
const path = require('path');
const { JsonProvider } = require(path.join(__dirname, '../electron/storage/json-provider.js'));

const [dir, seed] = process.argv.slice(2);
const p = new JsonProvider(dir, { seedPath: seed });

(async () => {
  const doc = await p.load();
  let n = 0;
  // Tight save loop with a growing doc so file size varies across kills.
  for (;;) {
    n++;
    doc.title = `kill-test round ${n} ${'x'.repeat(n % 200)}`;
    doc.goals[0].inits[0].moves[0].label = `move v${n}`;
    await p.save(doc);
  }
})();
