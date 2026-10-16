// The component gallery: gallery.html?frame=<id>&theme=light|dark&narrow=1 mounts one drawn state of the redesign's
// presentational components (contract C8) inside a window-sized frame. gallery.html alone lists every frame.
// components.spec.mts screenshots them against the Claude Design board.
import '../../../apps/desktop/src/style.css';
import { createRoot } from 'react-dom/client';
import { renderers } from './frames';
import { registry, sizeOf } from './registry';

const params = new URLSearchParams(window.location.search);
const frame = registry.find(entry => entry.id === params.get('frame'));
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const narrow = params.get('narrow') === '1';
document.documentElement.dataset.theme = theme;

const root = createRoot(document.getElementById('root')!);
if (!frame) {
  root.render(<ul style={{ font: '13px var(--font-body)', padding: 24, lineHeight: 1.8 }}>{registry.map(entry => <li key={entry.id}>
    {entry.id} · <a href={`?frame=${entry.id}&theme=light`}>light</a> · <a href={`?frame=${entry.id}&theme=dark`}>dark</a> · <a href={`?frame=${entry.id}&theme=light&narrow=1`}>900</a>
  </li>)}</ul>);
} else {
  const { width, height } = sizeOf(narrow);
  root.render(<div className="gallery-window" data-theme={theme} style={{ position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden', width, height,
    borderRadius: 10, background: 'var(--a-bg)', color: 'var(--color-text)', fontFamily: 'var(--font-body)' }}>
    {renderers[frame.id]!({ narrow, theme })}
  </div>);
}
