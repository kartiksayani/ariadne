for (const key of ['ARIADNE_E2E_BINARY', 'ARIADNE_E2E_ROOT', 'ARIADNE_E2E_NONCE', 'ARIADNE_E2E_PORT', 'ARIADNE_E2E_EVIDENCE']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const binary = process.env.ARIADNE_E2E_BINARY;
export const config = {
  runner: 'local', specs: ['./tests/e2e/native-smoke.spec.mjs'], maxInstances: 1,
  framework: 'mocha', reporters: ['spec'], logLevel: 'info',
  outputDir: process.env.ARIADNE_E2E_EVIDENCE,
  services: [['@wdio/tauri-service', {
    mode: 'native', driverProvider: 'embedded', appBinaryPath: binary,
    embeddedPort: Number(process.env.ARIADNE_E2E_PORT),
    startTimeout: 60000, statusPollTimeout: 5000, commandTimeout: 30000,
  }]],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: binary } }],
  connectionRetryTimeout: 60000, connectionRetryCount: 0,
  waitforTimeout: 10000, specFileRetries: 0, mochaOpts: { timeout: 60000, parallel: false },
};
