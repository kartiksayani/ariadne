import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreError, CoreErrorCode } from '../../../src/generated/core';
import { COULDNT_DO_THAT, CoreFailure, OwnFailure, plainFailure, registrationFailure, ServiceFailure } from '../../../src/data';

const codes: readonly CoreErrorCode[] = ['invalid_argument', 'not_found', 'binding_ambiguous', 'binding_mismatch', 'binding_conflict', 'stale_generation',
  'incompatible_adapter', 'host_unreachable', 'revision_conflict', 'question_changed', 'unhandled_owner_message', 'invalid_ref', 'invalid_transition',
  'operation_reused', 'result_already_committed', 'attempt_sealed', 'result_missing', 'delivery_uncertain', 'queue_full', 'topic_not_archivable',
  'session_not_closable', 'preview_stale', 'snapshot_changed', 'io_error', 'store_busy', 'capacity_exceeded', 'commit_uncertain', 'corrupt_session',
  'future_schema', 'permission_denied', 'unsupported', 'protocol_conflict', 'unsupported_host_version', 'control_path_too_long'];
const failure = (code: CoreErrorCode, message = 'The session revision changed before cancellation', hint = 'Reload the snapshot') =>
  new CoreFailure({ code, message, hint, retryable: false, field_errors: [] } satisfies CoreError);

afterEach(() => { vi.restoreAllMocks(); });

describe('what a failure says to the owner', () => {
  it.each(codes)('says %s in one plain sentence, never in core’s own words', code => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const text = plainFailure(failure(code));
    expect(text).toMatch(/[.…]$/);
    expect(text).not.toContain('revision changed before cancellation');
    expect(text).not.toContain('Reload the snapshot');
    expect(text).not.toContain(code);
  });
  it('falls back to "Ariadne couldn’t do that. Try again." for anything it has no words for', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(COULDNT_DO_THAT).toBe('Ariadne couldn’t do that. Try again.');
    expect(plainFailure(failure('operation_reused'))).toBe(COULDNT_DO_THAT);
    expect(plainFailure(new Error('TypeError: x is undefined'))).toBe(COULDNT_DO_THAT);
    expect(plainFailure('boom')).toBe(COULDNT_DO_THAT);
    expect(plainFailure(undefined)).toBe(COULDNT_DO_THAT);
    expect(plainFailure(new ServiceFailure('invalid_response'))).toBe(COULDNT_DO_THAT);
    expect(plainFailure(new Error('raw'), 'The name could not be saved. Try again.')).toBe('The name could not be saved. Try again.');
  });
  it('keeps the raw detail out of the screen and in the console for diagnostics', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    plainFailure(failure('revision_conflict'));
    expect(debug).toHaveBeenCalledWith('Ariadne core error', 'revision_conflict', 'The session revision changed before cancellation', 'Reload the snapshot');
  });
  it('says a lost connection to the background service in plain words', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(plainFailure(new ServiceFailure('transport'))).toBe('Ariadne couldn’t reach its background service. Try again.');
  });
  it('shows a failure Ariadne wrote itself as written', () => {
    const own = new OwnFailure({ code: 'invalid_argument', message: 'This same message is already waiting to be sent.', hint: '', retryable: false, field_errors: [] });
    expect(plainFailure(own)).toBe('This same message is already waiting to be sent.');
  });
  it('shows core’s own words only when registering a project, where core writes them for the owner', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const folder = failure('not_found', 'Folder not found: /Users/owner/missing', 'Check the folder path, then register again.');
    expect(registrationFailure(folder)).toBe('Folder not found: /Users/owner/missing Check the folder path, then register again.');
    expect(plainFailure(folder)).toBe('Ariadne can’t find that any more. It may have been removed.');
    expect(registrationFailure(new Error('raw'))).toBe(COULDNT_DO_THAT);
  });
});
