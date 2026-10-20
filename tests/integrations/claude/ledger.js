import { expect, vi } from 'vitest';

// The liveness rule says every health call settles with exactly one outcome.
// Wrapping a conversation health counts that from the outside: what each
// producer opened, and what it settled with. Share one wrapper between suites:
//
//   vi.mock('<path>/contracts.js',async importOriginal => {
//     const actual = await importOriginal(), {trackedHealth} = await import('./ledger.js');
//     return {...actual,conversationHealth:(...args) => trackedHealth(actual.conversationHealth(...args))};
//   });
//
// then `await balanced()` where every call must have settled, and clear the
// ledgers between tests with `resetLedgers()`.
export const ledgers = [];

/** The counts for one health: calls opened and outcomes settled per producer, and outcomes settled twice. */
export function newLedger() {
  return {opened:{},settled:{},twice:0};
}

/** Why a ledger is out of balance, or null when every opened call settled exactly once. */
export function imbalance(ledger) {
  if (ledger.twice) return `${ledger.twice} calls settled twice`;
  for (const producer of new Set([...Object.keys(ledger.opened),...Object.keys(ledger.settled)])) {
    const opened = ledger.opened[producer] ?? 0, settled = ledger.settled[producer] ?? 0;
    if (opened !== settled) return `${producer} opened ${opened} calls but settled ${settled}`;
  }
  return null;
}

/** `health` with its calls counted into `ledger`; background-off (owner) calls are not health calls and are not counted. */
export function counted(health, ledger = newLedger()) {
  const wrapped = {...health,
    call($, producer) {
      const settle = health.call($,producer);
      if ($.background === false) return settle;
      ledger.opened[producer] = (ledger.opened[producer] ?? 0) + 1;
      let done = false;
      return outcome => {
        if (done) ledger.twice += 1;
        else ledger.settled[producer] = (ledger.settled[producer] ?? 0) + 1;
        done = true;
        return settle(outcome);
      };
    },
    record($, producer, outcome) {return wrapped.call($,producer)(outcome);},
  };
  return wrapped;
}

/** Like `counted`, and the ledger joins the shared list that `balanced()` checks. */
export function trackedHealth(health) {
  const ledger = newLedger();
  ledgers.push(ledger);
  return counted(health,ledger);
}

/** Every call of every tracked health settled exactly once. */
export async function balanced() {
  await vi.waitFor(() => {
    for (const ledger of ledgers) expect(imbalance(ledger)).toBeNull();
  });
  resetLedgers();
}

export function resetLedgers() {
  ledgers.length = 0;
}
