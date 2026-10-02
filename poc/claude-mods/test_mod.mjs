// Mock-host tests for register.js. These test adapter behavior, not a live Claude REPL.
import test from 'node:test'
import assert from 'node:assert/strict'

async function harness({ items = ['item-1'], submitResult = { text: 'queued' } } = {}) {
  // A fresh module instance avoids sharing the mod's module-level state across tests.
  const { register } = await import(`./plugin/hooks/register.js?test=${Math.random()}`)
  const hooks = []
  const timers = []
  const submissions = []
  const brokerCalls = []
  const logs = []
  const queue = items.map((item, i) => ({ id: `input-${i + 1}`, item, text: `message-${i + 1}`, state: 'queued' }))
  const state = { generation: null, paused: false, sessionId: 'session-1' }
  const $ = {
    plugin: { root: '/plugin' },
    command: { register: async () => {} },
    clock: { every: (ms, fn) => { timers.push({ ms, fn }); return { cancel() {} } } },
    session: { id: async () => state.sessionId, cwd: async () => '/project' },
    process: {
      run: async (argv, init) => {
        const action = argv.at(-1)
        const request = JSON.parse(init.stdin)
        brokerCalls.push({ action, request })
        let result
        if (action === 'connect') {
          state.generation = `generation-${brokerCalls.length}`
          result = { session: request.session, generation: state.generation, paused: state.paused }
        } else {
          if (request.generation !== state.generation) return { exitCode: 1, stderr: 'Stale or unbound bridge generation' }
          if (action === 'claim') {
            const next = !state.paused && queue.find(row => row.state === 'queued')
            if (next) next.state = 'claimed'
            result = next ?? null
          } else if (action === 'started') {
            const row = queue.find(input => input.id === request.id)
            row.state = 'running'
            row.turnId = request.turnId
            result = { ok: true }
          } else if (action === 'completed') {
            const row = queue.find(input => input.id === request.id)
            row.state = request.reason === 'answer' && !request.isAborted ? 'done' : 'failed'
            state.paused ||= row.state === 'failed'
            result = { ok: true }
          } else if (action === 'failed') {
            state.paused = true
            result = { ok: true }
          } else if (action === 'disconnected') {
            state.paused = true
            result = { ok: true }
          } else if (action === 'submit-result') result = { ok: true }
        }
        return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' }
      },
    },
    prompt: { submit: async (input) => { submissions.push(input); return submitResult } },
    ui: { log: text => logs.push(text) },
  }
  register((name, matcher, hook) => {
    if (typeof matcher === 'function') hooks.push({ name, matcher: undefined, hook: matcher })
    else hooks.push({ name, matcher, hook })
  })
  const call = async (name, event = {}) => {
    const found = hooks.find(reg => reg.name === name && (!reg.matcher || Object.entries(reg.matcher).every(([k, v]) => event[k] === v)))
    assert.ok(found, `hook ${name} should exist`)
    return found.hook($, event, async e => ({ ...e }))
  }
  await call('session.start', { cwd: '/project', surface: 'terminal', isInteractive: true })
  const command = async name => {
    const found = hooks.find(reg => reg.name === 'command.run' && reg.matcher.command === name)
    return found.hook($, { command: name }, async e => e)
  }
  await command('ariadne-connect')
  async function tick() {
    await timers[0].fn()
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve))
  }
  return { $, hooks, timers, submissions, brokerCalls, logs, queue, state, call, command, tick }
}

test('binds to the current interactive session and installs one-second polling', async () => {
  const h = await harness()
  assert.equal(h.brokerCalls[0].action, 'connect')
  assert.equal(h.brokerCalls[0].request.session, 'session-1')
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, 1000)
})

test('claims and submits only one queued input while it is outstanding', async () => {
  const h = await harness({ items: ['one', 'two'] })
  await h.tick()
  assert.equal(h.submissions.length, 1)
  assert.match(h.submissions[0].text, /\[ARIADNE_INPUT:input-1\]/)
  await h.tick()
  assert.equal(h.submissions.length, 1)
  assert.equal(h.queue[1].state, 'queued')
})

test('unrelated main-thread and subagent completion do not drain the active input', async () => {
  const h = await harness({ items: ['one', 'two'] })
  await h.tick()
  await h.call('turn.complete', { turnId: 'other-turn', reason: 'answer', isAborted: false, answer: 'unrelated' })
  await h.call('turn.complete', { turnId: 'agent-turn', agentId: 'agent-1', reason: 'answer', isAborted: false, answer: 'subagent' })
  assert.equal(h.brokerCalls.some(call => call.action === 'completed'), false)
  await h.tick()
  assert.equal(h.submissions.length, 1)
})

test('matching answer completion clears active so the next queued input can submit', async () => {
  const h = await harness({ items: ['one', 'two'] })
  await h.tick()
  const id = 'input-1'
  await h.call('turn.start', { turnId: 'turn-1', text: `[ARIADNE_INPUT:${id}]` })
  await h.call('turn.complete', { turnId: 'turn-1', reason: 'answer', isAborted: false, answer: 'reply' })
  assert.equal(h.queue[0].state, 'done')
  await h.tick()
  assert.equal(h.submissions.length, 2)
  assert.match(h.submissions[1].text, /\[ARIADNE_INPUT:input-2\]/)
})

test('aborted turn pauses the bridge and prevents the following queued input', async () => {
  const h = await harness({ items: ['one', 'two'] })
  await h.tick()
  await h.call('turn.start', { turnId: 'turn-1', text: '[ARIADNE_INPUT:input-1]' })
  await h.call('turn.complete', { turnId: 'turn-1', reason: 'aborted', isAborted: true, answer: '' })
  await h.tick()
  assert.equal(h.state.paused, true)
  assert.equal(h.submissions.length, 1)
})

test('dropped submission halts polling instead of replaying uncertain input', async () => {
  const h = await harness({ items: ['one', 'two'], submitResult: { drop: 'rejected by hook' } })
  await h.tick()
  assert.equal(h.submissions.length, 1)
  await h.tick()
  assert.equal(h.submissions.length, 1)
  assert.equal(h.logs.some(line => line.includes('Submission dropped')), true)
})
