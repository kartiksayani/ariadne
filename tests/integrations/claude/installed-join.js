// Scripted SDK only. Every helper command executes the installed production CLI.
// The Rust consuming test owns the real native activation/control/Core/Store.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { deferred, host } from './fixtures.js';

const [pluginRoot, projectRoot] = process.argv.slice(2);
const { register } = await import(pathToFileURL(`${pluginRoot}/hooks/register.js`));
const hooks = new Map();
const reports = [];
const replies = [];
const submissions = [];
let running = 0;
let loseStatusAck = false;
async function execute(argv, options) {
  running += 1;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio:['pipe','pipe','pipe'], timeout:options.timeoutMs });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
      child.stdin.end(options.stdin ?? '');
    });
    replies.push({ argv, result });
    if (loseStatusAck && argv[1] === 'bridge' && argv[2] === 'connection-status') {
      loseStatusAck = false;
      throw new Error('Scripted SDK lost the actual helper status result');
    }
    if (argv[1] === 'bridge' && argv[2] === 'report' && result.exitCode === 0) reports.push(JSON.parse(options.stdin));
    return result;
  } finally { running -= 1; }
}
const fixture = host({handler:execute, submit:args => {
  const pending = deferred();
  submissions.push({ ...pending, text:args.text });
  return pending.promise;
}});
fixture.$.plugin.root = pluginRoot;
fixture.$.session.cwd = async () => projectRoot;
register((event, spec, callback) => hooks.set(`${event}:${typeof spec === 'function' ? '' : spec.command}`, typeof spec === 'function' ? spec : callback));
const next = event => event;
async function drain() {
  const until = Date.now() + 6000;
  // Timer callbacks and detached settlement deliberately do not return their jobs.
  do {
    await new Promise(resolve => setTimeout(resolve, 10));
    if (Date.now() > until) throw new Error('Installed helper did not settle within the fixture bound');
  } while (running);
}
async function until(predicate) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Detached Mod evidence did not settle within the fixture bound');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await drain();
}
for await (const line of createInterface({input:process.stdin})) {
  try {
    const request = JSON.parse(line);
    let value = null;
    switch (request.action) {
      case 'start': value = await hooks.get('session.start:')(fixture.$,{},next); break;
      case 'connect': value = await hooks.get('command.run:ariadne-connect')(fixture.$,{args:request.session}); break;
      case 'heartbeat': await fixture.timers().find(timer => timer.ms === 30000).callback(); break;
      case 'lose-status-ack': loseStatusAck = true; break;
      case 'poll': {
        const previousReplies = replies.length, previousPrompts = fixture.prompts.length, previousLogs = fixture.logs.length;
        fixture.timer().callback();
        await drain();
        const claimed = replies.slice(previousReplies).find(reply => reply.argv[2] === 'claim');
        if (claimed?.result.exitCode === 0 && JSON.parse(claimed.result.stdout).data !== null) {
          // Payload verification uses async WebCrypto after the helper exits.
          await until(() => fixture.prompts.length > previousPrompts || fixture.logs.length > previousLogs);
        }
        break;
      }
      case 'settle': {
        const submission = submissions[request.index];
        if (request.reject) submission.reject(new Error('scripted SDK delivery unknown'));
        else submission.resolve(request.drop ? {drop:'scripted drop'} : {text:submission.text});
        const attempt = submission.text.split('\n')[0].split(':')[2].replace(']','');
        await until(() => reports.some(event => event.attempt_id === attempt
          && event.kind === (request.reject ? 'uncertain' : request.drop ? 'rejected' : 'accepted')));
        break;
      }
      case 'event': value = await hooks.get(`${request.name}:`)(fixture.$,request.event,next); break;
      case 'call': value = await execute(request.argv,{stdin:request.stdin,timeoutMs:5000}); break;
      case 'state': break;
      default: throw new Error('Unknown SDK fixture command');
    }
    await drain();
    process.stdout.write(`${JSON.stringify({value,prompts:fixture.prompts,reports,replies,logs:fixture.logs,commands:fixture.commands})}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({error:error.message})}\n`);
  }
}
