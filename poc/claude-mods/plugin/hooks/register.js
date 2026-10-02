// Claude Code 2.1.287. Only explicitly queued owner messages start model turns.
let binding = null;
let active = null;
let polling = false;
let halted = false;

async function broker($, action, data) {
  const project = binding ? binding.project : await $.session.cwd();
  const result = await $.process.run(
    ['rtk', 'proxy', 'python3', $.plugin.root + '/scripts/broker.py', '--project', project, action],
    { stdin: JSON.stringify(data), timeoutMs: 5000 },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr || 'Ariadne broker failed');
  return JSON.parse(result.stdout);
}

async function recordFailure($, error, claim = null) {
  halted = true;
  const failed = claim || (binding && active ? { ...binding, id: active.id } : null);
  if (failed) {
    await broker($, 'failed', { ...failed, error: String(error) });
  }
  $.ui.log('Ariadne POC paused: ' + String(error));
}

async function poll($) {
  if (!binding || active || polling || halted) return;
  polling = true;
  try {
    if (await $.session.id() !== binding.session) {
      halted = true;
      await broker($, 'disconnected', binding);
      return;
    }
    const input = await broker($, 'claim', binding);
    if (!input) return;
    active = { id: input.id, turnId: null };
    if (await $.session.id() !== binding.session) throw new Error('Session changed after claim');
    const claim = { ...binding, id: input.id };
    const text = '[ARIADNE_INPUT:' + input.id + ']\n'
      + 'The owner sent a message on Ariadne item ' + JSON.stringify(input.item) + '.\n'
      + 'Continue in this conversation, using its existing context. Reply to the owner.\n'
      + 'Owner message:\n' + input.text;
    // Detached: queued submission must not hold a lifecycle hook or timer callback.
    void $.prompt.submit({ text }).then(async (result) => {
      await broker($, 'submit-result', { ...claim, result });
      if (result.drop !== undefined) await recordFailure($, 'Submission dropped: ' + result.drop, claim);
    }).catch(async (error) => {
      try { await recordFailure($, error, claim); }
      catch (failure) { halted = true; $.ui.log(String(failure)); }
    });
  } catch (error) {
    await recordFailure($, error);
  } finally {
    polling = false;
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ariadne-connect', description: 'Bind this Claude conversation to the local POC queue' });
    await $.command.register({ name: 'ariadne-status', description: 'Show the Ariadne POC session and queue' });
    $.clock.every(1000, () => { void poll($).catch((error) => { halted = true; $.ui.log(String(error)); }); });
    return next(e);
  });

  on('command.run', { command: 'ariadne-connect' }, async ($) => {
    if (active) return { text: 'An input is outstanding; finish it before reconnecting.' };
    const session = await $.session.id();
    const project = await $.session.cwd();
    binding = null;
    const result = await broker($, 'connect', { session });
    binding = { session, project, generation: result.generation };
    halted = result.paused;
    return { text: JSON.stringify({ ...binding, paused: halted }) };
  });

  on('command.run', { command: 'ariadne-status' }, async ($) => {
    const session = await $.session.id();
    return { text: JSON.stringify({ currentSession: session, binding, active, halted }) };
  });

  on('turn.start', async ($, e, next) => {
    if (binding && active && !active.turnId && e.text.includes('[ARIADNE_INPUT:' + active.id + ']')) {
      if (await $.session.id() !== binding.session) {
        await recordFailure($, 'Session changed before turn started');
      } else {
        active.turnId = e.turnId;
        try { await broker($, 'started', { ...binding, id: active.id, turnId: e.turnId }); }
        catch (error) { await recordFailure($, error); }
      }
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && binding && active && active.turnId === e.turnId) {
      try {
        await broker($, 'completed', { ...binding, id: active.id, turnId: e.turnId,
          answer: e.answer, reason: e.reason, isAborted: e.isAborted, durationMs: e.durationMs });
        halted = halted || e.reason !== 'answer' || e.isAborted;
        active = null;
      } catch (error) { await recordFailure($, error); }
    }
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    halted = true;
    if (binding) {
      try { await broker($, 'disconnected', binding); }
      catch (error) { $.ui.log(String(error)); }
    }
    binding = null;
    active = null;
    return next(e);
  });
}
