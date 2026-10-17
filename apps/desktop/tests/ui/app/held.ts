import type { OwnerMutationRequest } from '../../../src/generated/core';
import type { DesktopTransport } from '../../../src/data/service';
import { AppTransport } from './transport';

/** A transport whose core holds every theme change while `hold` is set, as a slow write does. */
export class HeldTransport extends AppTransport {
  hold: Promise<void> | null = null;
  /** Theme changes the core is holding right now. */
  held = 0;
  override async invoke<T>(name: string, args: Parameters<DesktopTransport['invoke']>[1]): Promise<T> {
    const request = args.request as OwnerMutationRequest;
    const changesTheme = 'command' in request && request.command.command === 'preferences_patch'
      && request.command.params.entries.some(entry => entry.kind === 'set_global' && entry.preferences.theme !== this.preferences.global.theme);
    if (this.hold && changesTheme) { ++this.held; await this.hold; --this.held; }
    return super.invoke<T>(name, args);
  }
}
