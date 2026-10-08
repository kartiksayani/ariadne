import { describe, it, expect } from 'vitest';
import { forget, recall, remember } from '../../../integrations/claude/plugin/hooks/setup.js';
import { host, ids } from './fixtures.js';

describe('remembered Ariadne session per Claude conversation', () => {
  it('remembers, recalls and forgets one conversation in the plugin store', async () => {
    const h = host();
    expect(await recall(h.$,'conversation')).toBe(null);
    await remember(h.$,'conversation',{project_id:ids.project,session_id:ids.session});
    expect(await recall(h.$,'conversation')).toEqual({project_id:ids.project,session_id:ids.session});
    expect(await recall(h.$,'another-conversation')).toBe(null);
    await forget(h.$,'conversation');
    expect(h.store.size).toBe(0);
  });
  it('ignores malformed entries and a store that fails', async () => {
    const h = host({store:new Map([['binding:conversation',{session_id:'not-a-uuid'}]])});
    expect(await recall(h.$,'conversation')).toBe(null);
    const broken = host();
    broken.$.store.get = async () => { throw new Error('store unavailable'); };
    broken.$.store.set = async () => { throw new Error('store unavailable'); };
    expect(await recall(broken.$,'conversation')).toBe(null);
    await expect(remember(broken.$,'conversation',{project_id:ids.project,session_id:ids.session})).resolves.toBeUndefined();
  });
  it('keeps only the fifty most recent conversations', async () => {
    const store = new Map(Array.from({length:50},(_,index) => [`binding:old-${index}`,
      {project_id:ids.project,session_id:ids.session,saved_at:new Date(Date.UTC(2026,0,1,0,index)).toISOString()}]));
    store.set('unrelated',{kept:true});
    const h = host({store});
    await remember(h.$,'newest',{project_id:ids.project,session_id:ids.session});
    expect(store.has('binding:old-0')).toBe(false);
    expect(store.has('binding:old-1')).toBe(true);
    expect(store.has('binding:newest')).toBe(true);
    expect(store.has('unrelated')).toBe(true);
    expect([...store.keys()].filter(key => key.startsWith('binding:'))).toHaveLength(50);
  });
});
