import { vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Session } from '../../../src/generated/domain/models';
import { ChangesOpener } from '../../../src/ui/changes/ChangesOpener';
import { NavigationStore, useNavigation } from '../../../src/state/navigation/store';
import { useReadingSeen } from '../../../src/state/preferences/reading';
import { createDesktopService } from '../../../src/data/service';
import { AppTransport, route } from '../app/transport';
import { changesFixture } from './fixture';

export const stores: NavigationStore[] = [];

/**
 * A session with unseen changes and the band's What changed opener rendered the way the Map does: `seen` comes from the shared
 * reading lane, the session is a fresh clone per render. Fake timers run from just after the fixture's changes
 * (or three days later with `away`, which makes the absence long).
 */
export async function setupChanges(updated = 1, replaced = 0, added = 0, away = false) {
  vi.useFakeTimers(); vi.setSystemTime(away ? '2026-10-13T12:00:00Z' : '2026-10-10T02:00:00Z');
  const value = changesFixture(updated, replaced, added), transport = new AppTransport();
  transport.sessions.set(value.session.id, value.session); transport.preferences.seen = [value.seen];
  transport.preferences.global.selected_navigation = { kind: 'session', session: route };
  const navigation = new NavigationStore(createDesktopService(transport)); stores.push(navigation);
  await navigation.start(); await navigation.opened.open(route).refresh();
  const onOpenItem = vi.fn();
  function Harness({ session }: { readonly session: Session }) {
    const nav = useNavigation(navigation), seen = useReadingSeen(navigation.reading, nav.preferences, route);
    return <div className="product-app"><div className="tree-column"><div className="tree-topic">
      <ChangesOpener session={session} topicId={value.topic.id} seen={seen} navigation={navigation} onOpenItem={onOpenItem} /></div></div></div>;
  }
  const element = () => <Harness session={structuredClone(value.session)} />;
  const rendered = render(element());
  return { ...value, transport, navigation, onOpenItem, element, ...rendered };
}
