import { createRoot } from 'react-dom/client';
import { cases } from './cases';
declare global {
  interface Window { __ariadneReferenceCases: Omit<(typeof cases)[number], 'render'>[] }
}
window.__ariadneReferenceCases = cases.map(({ id, component, source, region }) => ({ id, component, source, region }));
const query = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark';
const fixture = cases.find(fixture => fixture.id === query.get('case'));
if (!fixture) throw new Error('Unknown reference fixture');
createRoot(document.getElementById('root')!).render(fixture.render());
