import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { identity, alive, stop } from '../../../scripts/run-native-e2e.mjs';

function message(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.off('message', receive); reject(new Error(`Missing ${type} message`)); }, 5000);
    const receive = value => {
      if (value.type !== type) return;
      clearTimeout(timeout); child.off('message', receive); resolve(value);
    };
    child.on('message', receive);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} enters ordinary cleanup, exits with failure and leaves no owned detached PID`, { timeout: 10000 }, async () => {
    const child = fork(fileURLToPath(new URL('./cancellation-probe.mjs', import.meta.url)), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    let owned = [];
    try {
      const ready = await message(child, 'ready'); owned = ready.owned;
      assert.equal(owned.length, 3);
      for (const processRecord of owned) assert.ok(alive(processRecord.pid));
      const cleaned = message(child, 'cleanup'), finished = message(child, 'done');
      child.kill(signal);
      assert.deepEqual((await cleaned).pidExited, [true, true, true]);
      const done = await finished;
      assert.match(done.failure, new RegExp(signal));
      assert.equal(done.handlersRestored, true);
      assert.deepEqual(await exited, [1, null]);
      for (const processRecord of owned) assert.equal(alive(processRecord.pid), false);
    } finally {
      await stop(child);
      // A broken cleanup test still owns these exact stand-ins. Reject PID reuse
      // before signalling their individual tracked process groups.
      for (const processRecord of owned) {
        if (!alive(processRecord.pid)) continue;
        const current = identity(processRecord.pid);
        assert.deepEqual({ pid: current.pid, exe: current.exe, birth: current.birth },
          { pid: processRecord.pid, exe: processRecord.exe, birth: processRecord.birth });
        await stop({ pid: processRecord.pid });
      }
    }
  });
}
