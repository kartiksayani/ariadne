// Disposable Node stand-ins only: never an App, driver, native build or cache.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withCancellation } from './cancellation.mjs';
import { identity, alive, stop } from '../../../scripts/run-native-e2e.mjs';

const previous = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
let failure;
try {
  await withCancellation(async signal => {
    const owned = [];
    try {
      for (let count = 0; count < 3; count++) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        owned.push(child);
        await once(child, 'spawn');
      }
      process.send({ type: 'ready', owned: owned.map(child => identity(child.pid)) });
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } finally {
      for (const child of owned.reverse()) await stop(child);
      process.send({ type: 'cleanup', pidExited: owned.map(child => !alive(child.pid)) });
    }
  });
} catch (error) {
  failure = error.message;
  process.exitCode = 1;
} finally {
  process.send({ type: 'done', failure, handlersRestored: ['SIGINT', 'SIGTERM'].every((name, index) => process.listenerCount(name) === previous[index]) });
  process.disconnect();
}
