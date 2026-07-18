// Playwright config for Electron e2e. Run under xvfb on Linux CI:
//   xvfb-run -a npm run test:e2e
module.exports = {
  testDir: __dirname,
  timeout: 60000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {},
};
