// Base styles first, as in main.tsx.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { DesktopApp } from '../../../apps/desktop/src/App';
import { createDesktopService } from '../../../apps/desktop/src/data/service';
import { AppTransport, route } from '../../../apps/desktop/tests/ui/app/transport';

// The ordinary App over its real stores; only the native transport is replaced.
// Item 1 carries a long finding (it must fold to six lines), item 5 a paragraph that
// wraps over a few lines (hover must not rewrap it), the rest keep their short text.
class TreeLayoutTransport extends AppTransport {
  constructor() {
    super();
    const items = this.sessions.get(route.session_id)!.items;
    items['1']!.outcome = Array.from({ length: 20 }, (_, index) => `Line ${index + 1} of a long finding the agent wrote.`).join('\n');
    items['5']!.outcome = 'A decision paragraph that is long enough to wrap over several lines in the tree column, so that any change in the width of its '
      + 'column on hover would move words from one line to the next and show up as a different line count.';
  }
}
createRoot(document.getElementById('root')!).render(<DesktopApp service={createDesktopService(new TreeLayoutTransport())} />);
