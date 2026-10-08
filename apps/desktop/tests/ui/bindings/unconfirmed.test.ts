import { describe, expect, it } from 'vitest';
import { unconfirmedText } from '../../../src/components/bindings/unconfirmed';
import type { OwnerCommand } from '../../../src/generated/core';

describe('what an unconfirmed saved action is called', () => {
  it('uses plain words for the rename and for taking a message back', () => {
    expect(unconfirmedText('session_label_set')).toBe('The new session name isn’t confirmed yet');
    expect(unconfirmedText('input_cancel')).toBe('Taking the message back isn’t confirmed yet');
  });
  it('never shows a command name', () => {
    const commands: OwnerCommand['command'][] = ['project_register', 'binding_connect', 'binding_pause', 'binding_resume', 'binding_disconnect',
      'input_submit', 'input_cancel', 'input_resolve', 'topic_archive', 'topic_restore', 'session_close', 'session_reopen', 'topic_continue',
      'preferences_patch', 'item_remove', 'topic_remove', 'session_remove', 'project_remove', 'session_label_set'];
    for (const command of commands) expect(unconfirmedText(command)).toMatch(/^[A-Z][a-z]+( [A-Za-z’]+)+ isn’t confirmed yet$/);
    for (const command of commands) expect(unconfirmedText(command)).not.toMatch(/_/);
  });
});
