import { beforeEach } from 'vitest';

// jsdom reports "no focus" until some element is focused. The window counts as in front unless a test says otherwise,
// because the seen dwell (ui/changes/useSeenDwell) runs only in a visible, focused window.
beforeEach(() => { document.hasFocus = () => true; });
