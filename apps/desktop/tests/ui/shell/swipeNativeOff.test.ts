// The web view's own back/forward swipe stays off (alpha.24 P2): the app has no page history, and the two-finger swipe is the app's
// own (SwipeNavigation). wry leaves WKWebView's allowsBackForwardNavigationGestures off unless the shell asks for it; this keeps
// the shell from asking.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const shell = join(__dirname, '../../../src-tauri');
const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sources(join(directory, entry.name)) : /\.(rs|json|toml)$/.test(entry.name) ? [join(directory, entry.name)] : []);

describe('native back/forward gestures', () => {
  it('the shell never turns on the web view\'s own swipe navigation', () => {
    const files = sources(shell);
    expect(files.length).toBeGreaterThan(0);
    const asked = files.filter(file => /back_forward_navigation_gestures\s*\(\s*true|allowsBackForwardNavigationGestures|BackForwardNavigationGestures/i.test(readFileSync(file, 'utf8')));
    expect(asked).toEqual([]);
  });
});
