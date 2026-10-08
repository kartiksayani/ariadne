# ADR-0088: Core lifecycle and delivery never dead-end the owner

Status: accepted (2026-10-07).
Supersedes: none (amends one rule of ADR-0036)
Superseded by: none

## Context

Owner testing hit states the owner could not leave without a workaround:

- An input stayed stuck after the agent had saved its result.
- A settled input left dispatch paused.
- Session close needed an earlier Pause.
- Removal refused while inputs were pending.
- `/clear` in Claude Code left the new conversation unbound, because a rebind
  refused while inputs were pending.

The owner gave eight rulings and one rebind rule. Core should do the safe thing
itself.

## Decision

- **A committed result wins.** An attempt whose `input_result` is committed
  completes its input as `handled` once the turn ends. It also completes the input
  on a host failure, interruption or doubt, whether the signal came before or after
  the result. Late host facts are then dealt with as follows:
  - Core answers `Unchanged` to a new fact about a sealed or settled attempt, or
    about a handled, skipped or cancelled input. It never answers `AttemptSealed`
    (this replaces ADR-0036's rule that nonredundant additions reject it).
  - A changed fact under a known event ID is still saved as a `ProtocolConflict`,
    but once the attempt is settled or its result is committed it adds no barrier.
  - The supervisor treats `AttemptSealed` and any `ProtocolConflict` that carries
    a revision (the first answer as well as a replay) for an attempt fact as
    Core's final verdict: a conflict with a revision means Core already saved it.
    It drops the fact (with a log line) instead of retrying it, so later facts
    and claims are not held behind it. A `ProtocolConflict` without a revision
    is not treated as final.

  `input_resolve` with `accept_result` ("Mark as handled") exists
  only for inputs that earlier versions left stuck. It needs no attestation, reason
  or fresh revision.
- **Resolve resumes.** An `input_resolve` that settles the last input needing
  attention clears the input-caused `pause_reason` and re-enables dispatch, unless
  the owner paused it. Resolve never adds an owner pause. `reason` is optional, up to
  4096 bytes.
- **Close is one step.** `session_close` does four things:
  - pauses the binding;
  - cancels queued inputs;
  - abandons in-flight and needs-attention inputs (state `cancelled`, attempts
    sealed);
  - leaves items as they are.

  The `session_lifecycle` receipt lists `cancelled_input_ids`. `session_reopen`
  clears `owner_paused`, including an earlier explicit Pause.
- **Removal takes pending inputs.** Removal never refuses because inputs are
  pending; it also clears the binding's active input and barrier. The integrity
  refusals stay:
  - revision conflict;
  - a remaining item replaced by the removed work;
  - a remaining item that depends on a message of the removed work;
  - capacity limits;
  - partial family removal.
- **Cancel abandons.** `input_cancel` cancels queued, in-flight and needs-attention
  inputs. Late host facts about a cancelled input are ignored.
- **Distinct refusal reasons.** A claim on a closed session returns
  `session_closed`. A binding that no session holds returns `session_removed`. A
  binding that lacks a supervisor lease returns `not_found` with reason
  `lease_invalid` (`CoreService::unknown_binding_error`). Agent writes for a
  cancelled or removed input return `attempt_sealed` with reason `input_cancelled`.
- **Topic reply.** `InputKind::TopicReply` is an owner input aimed at a topic. Its
  result may carry no replies.
- **Rebind with pending inputs (`/clear`).** `binding_connect` with
  `existing_session_id` goes through, whatever the input state, when the old
  binding is disconnected or has the same `adapter_id`.
  - Queued inputs that were never sent move to the new binding in FIFO order.
  - An input whose attempt committed its result is handled.
  - Other sent inputs move to the new binding as `needs_attention` and become its
    active input, with `pause_reason: uncertain`. The owner then chooses "Send
    again" (`resend`) or "Mark as done" (`skip`).
  - `owner_paused` carries over.
  - Late facts from the retired binding return `stale_generation`.
  - `binding_conflict` remains only when the old binding is connected, belongs to
    another adapter, and has pending work or is not paused.

  Validation accepts messages and receipts that a retired binding of the session
  saved about a moved input.
- `Binding::dispatch_quiesced` is removed. Close no longer needs a quiesced binding.

## Consequences

- The owner never needs Pause before Close, Resume after a decision, or a manual
  cancel before Remove.
- Close and cancel do not stop the host. A turn already running may finish, but
  its facts change nothing.
- After a rebind, the old conversation's partial replies about a moved input stay
  in history under the old binding.
- Contract changes:
  - `InputKind::topic_reply`;
  - `ResolutionKind::accept_result`;
  - `BarrierReason` `session_closed`, `session_removed` and `input_cancelled`;
  - `SessionLifecycle.cancelled_input_ids`;
  - optional resolve `reason`.

## Spec references

- [API and MCP](../planning/low-level/API_AND_MCP.md)
- [UI and native](../planning/low-level/UI_AND_NATIVE.md)
