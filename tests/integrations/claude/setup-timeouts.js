import { vi } from 'vitest';

// vi.waitFor gives up after 1 s unless told otherwise. It returns the moment its callback stops throwing,
// so a longer limit costs nothing on a quiet machine and only ends a wait that can never succeed. A busy
// machine (a full run, a coverage build, another agent) can take longer than 1 s to run one timer tick and
// its reports. A caller that passes its own timeout keeps it.
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = (callback, options) => waitFor(callback, typeof options === 'number' ? options : { timeout: 10_000, ...options });
