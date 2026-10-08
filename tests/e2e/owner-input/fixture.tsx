// Base styles first, as in main.tsx.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { AppTransport, route } from '../../../apps/desktop/tests/ui/app/transport';

// The ordinary App and its real stores own the save flow. Only the native
// transport is replaced, as in the existing composition tests.
class LayoutTransport extends AppTransport {
  constructor() {
    super();
    const session = this.sessions.get(route.session_id)!;
    const item = session.items['2']!;
    item.question = 'Which native delivery window should we use?';
    item.ask = 'Choose the saved option and explain it in your own words.';
    const round = session.rounds[item.current_round_id!]!;
    round.question_snapshot = item.question;
    round.ask_snapshot = item.ask;
    // ?chat: item 2 offers two quick replies, and closed item 1 has three exchanges (its own, then two later ones).
    if (new URL(window.location.href).searchParams.has('chat')) {
      item.options = [{ id: 'yes', label: 'Keep the design', consequence: 'Retain the current contract.', recommended: true },
        { id: 'no', label: 'Change the design', consequence: 'Review a new contract.', recommended: false }];
      const first = Object.values(session.rounds).find(value => value?.item_id === '1')!;
      const owner = session.messages.find(message => message.id === first.owner_message_ids[0])!;
      for (const [ordinal, ask, said] of [[3, 'Third ask of the chat', 'Third reply of the chat'], [2, 'Second ask of the chat', 'Second reply of the chat']] as const) {
        const id = `00000000-0000-4000-8000-00000000090${ordinal}`, messageId = `00000000-0000-4000-8000-00000000091${ordinal}`;
        session.rounds[id] = { ...structuredClone(first), id, ordinal, ask_snapshot: ask, owner_message_ids: [messageId], agent_message_ids: [], result_input_ids: [], fork_item_ids: [], closed_at: null };
        session.messages.push({ ...structuredClone(owner), id: messageId, number: 80 + ordinal, body: said, input_id: null, round_id: id });
      }
    }
    if (new URL(window.location.href).searchParams.has('largeTree')) {
      const template = structuredClone(session.items['1']!);
      session.items = {};
      session.inputs = {}; session.operation_receipts = {};
      for (let root = 1; root <= 20; ++root) {
        for (let child = 0; child < 100; ++child) {
          const id = child ? `${root}.${child}` : String(root);
          session.items[id] = { ...structuredClone(template), id, ordinal: child || root, parent: child ? String(root) : null,
            question: `Sentence ${id}: ${'Variable height context. '.repeat(1 + child % 7)}`, status: child % 3 ? 'open' : 'done',
            owner: child % 2 ? { kind: 'other', name: 'Native collaborator' } : { kind: 'me' },
            current_round_id: null, next_child: child ? 1 : 100 };
        }
      }
      this.preferences.sessions[0]!.expanded_item_ids = Array.from({ length: 20 }, (_, index) => String(index + 1));
      this.preferences.sessions[0]!.rail = 'activity';
      this.preferences.global.selected_navigation = { kind: 'project', project_id: route.project_id };
    }
  }
  override async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
    if ('command' in request && request.command.command === 'binding_connect') {
      this.mutations.push(structuredClone(request));
      const session = this.sessions.get(route.session_id)!;
      const binding = session.bindings[session.active_binding_id!]!;
      return { api_version: 1, ok: true, data: { operation_id: request.command.op_id, session_id: session.id, revision: session.revision,
        data: { kind: 'binding_connect', binding_id: binding.id, generation: binding.generation, capabilities: binding.capabilities,
          setup_instruction: Array.from({ length: 30 }, (_, index) => `Setup step ${index + 1}: read the saved session context.`).join('\n') } } } as T;
    }
    if ('request' in request && request.request.command === 'item_rounds') {
      const itemId = request.request.params.item_id;
      const session = this.sessions.get(request.session!.session_id)!;
      const empty = { items: [], next_cursor: null, snapshot_revision: session.revision };
      return { api_version: 1, ok: true, data: { kind: name, data: {
        item_id: itemId,
        rounds: { ...empty, items: Object.values(session.rounds).filter(round => round?.item_id === itemId)
          .map(round => ({ round, answers: empty, owner_messages: empty, agent_messages: empty, results: empty, forks: empty })) },
      } } } as T;
    }
    return super.invoke<T>(name, args);
  }
}
createRoot(document.getElementById('root')!).render(<DesktopApp service={createDesktopService(new LayoutTransport())} />);
