import { createRoot } from 'react-dom/client';
import { cases } from './cases';
import { WorkspaceCase } from './workspace-cases';
declare global {
  interface Window { __ariadneReferenceCases: Omit<(typeof cases)[number], 'render'>[] }
}
window.__ariadneReferenceCases = cases.map(({ id, component, source, region, shortcutHint }) => ({ id, component, source, region, shortcutHint }));
const query = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark';
const frame = query.get('frame');
if (frame) {
  document.body.className = 'assembled-gallery';
  createRoot(document.getElementById('root')!).render(<WorkspaceCase frameId={frame} variant={query.get('variant') ?? undefined} />);
} else {
const fixture = cases.find(fixture => fixture.id === query.get('case'));
if (!fixture) throw new Error('Unknown reference fixture');
createRoot(document.getElementById('root')!).render(fixture.render());

}
