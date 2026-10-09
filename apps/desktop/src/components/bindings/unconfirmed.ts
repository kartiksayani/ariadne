// What a saved action is called to the owner while its result is unconfirmed.
// Core's command names ("session_label_set", "input_cancel") are never shown.
import type { OwnerCommand } from '../../generated/core';

const subject: Record<OwnerCommand['command'], string> = {
  ack: 'Acknowledging the item',
  project_register: 'Adding the project',
  binding_connect: 'Connecting the agent',
  binding_pause: 'Pausing sending',
  binding_resume: 'Resuming sending',
  binding_disconnect: 'Disconnecting the agent',
  input_submit: 'Sending your message',
  input_cancel: 'Taking the message back',
  input_resolve: 'Your decision about the message',
  topic_archive: 'Archiving the topic',
  topic_restore: 'Restoring the topic',
  session_close: 'Closing the session',
  session_archive: 'Archiving the session',
  session_restore: 'Restoring the session',
  session_reopen: 'Reopening the session',
  topic_continue: 'Continuing the topic',
  preferences_patch: 'Saving your settings',
  item_remove: 'Removing the item',
  topic_remove: 'Removing the topic',
  session_remove: 'Removing the session',
  project_remove: 'Removing the project',
  session_label_set: 'The new session name',
};

/** "The new session name isn’t confirmed yet", "Taking the message back isn’t confirmed yet". */
export const unconfirmedText = (command: OwnerCommand['command']) => `${subject[command]} isn’t confirmed yet`;
