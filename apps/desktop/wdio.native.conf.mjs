for (const key of ['ARIADNE_E2E_BINARY', 'ARIADNE_E2E_ROOT', 'ARIADNE_E2E_NONCE', 'ARIADNE_E2E_PORT', 'ARIADNE_E2E_EVIDENCE', 'ARIADNE_E2E_PHASE']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const binary = process.env.ARIADNE_E2E_BINARY;
const appArgs = JSON.parse(process.env.ARIADNE_E2E_APP_ARGS || '[]');
export const config = {
  runner: 'local', specs: ['./tests/e2e/native-smoke.spec.mjs'], maxInstances: 1,
  framework: 'mocha', reporters: ['spec'], logLevel: 'info',
  outputDir: process.env.ARIADNE_E2E_EVIDENCE,
  services: [['@wdio/tauri-service', {
    mode: 'native', driverProvider: 'embedded', appBinaryPath: binary, appArgs,
    embeddedPort: Number(process.env.ARIADNE_E2E_PORT),
    // Retain startup stderr in the private fixture evidence, including onPrepare failures.
    captureBackendLogs: true,
    startTimeout: 60000, statusPollTimeout: 5000, commandTimeout: 30000,
  }]],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary, args: appArgs } }],
  connectionRetryTimeout: 60000, connectionRetryCount: 0,
  // waitForDisplayed, waitForEnabled and the like give up after this; they return the moment the element is ready,
  // so a loaded machine gets time to draw it and a missing element still fails.
  waitforTimeout: 30000, specFileRetries: 0, mochaOpts: { timeout: 480000, parallel: false },
};
