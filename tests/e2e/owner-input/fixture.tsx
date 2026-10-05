import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { AppTransport, route } from '../../../apps/desktop/tests/ui/app/transport';
import '../../../apps/desktop/src/style.css';

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
  }
  override async invoke<T>(name: string, args: Parameters<AppTransport['invoke']>[1]): Promise<T> {
    const request = args.request;
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
