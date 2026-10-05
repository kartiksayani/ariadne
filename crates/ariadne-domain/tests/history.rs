use ariadne_domain::models::*;

const SEED: &str = include_str!("../../../fixtures/domain/history/seed.json");

fn seed() -> Session {
    serde_json::from_str(SEED).unwrap()
}

fn id(n: u64) -> UuidV4 {
    UuidV4::new(format!("00000000-0000-4000-8000-{n:012x}")).unwrap()
}

fn item(n: &str) -> ItemRef {
    ItemRef::new(n).unwrap()
}

fn at() -> UtcMillis {
    UtcMillis::new("2026-10-03T12:01:00.000Z").unwrap()
}

#[test]
fn canonical_seed_retains_full_creation_body_and_terminal_outcome() {
    let session = seed();
    assert_eq!(session.id, id(2));
    assert_eq!(session.messages.len(), 1);
    assert!(session.messages[0].body.contains('\n'));
    let finished = &session.items.0[&item("2")];
    assert_eq!(finished.status, ItemStatus::Done);
    assert_eq!(
        finished.outcome.as_deref(),
        Some("Recorded original reference.")
    );
    assert!(session.rounds.0.is_empty());
    assert_eq!(
        session.messages[0].created_at.as_str(),
        "2026-10-03T12:00:00.000Z"
    );
    assert_ne!(session.created_at, at());
    let emitted = serde_json::to_string(&session).unwrap();
    assert_eq!(serde_json::from_str::<Session>(&emitted).unwrap(), session);
}

use ariadne_domain::history::*;

fn p(n: u64) -> PositiveSafeInteger {
    PositiveSafeInteger::new(n).unwrap()
}
fn options(n: u64) -> Vec<ItemOption> {
    vec![ItemOption {
        id: format!("option-{n}"),
        label: format!("Approach {n}"),
        consequence: format!("Keeps round {n} evidence.\nSecond line."),
        recommended: true,
    }]
}
fn context() -> AgentHistoryContext {
    AgentHistoryContext {
        binding_id: id(3),
        generation: id(4),
        source_input_id: None,
        attempt_id: None,
    }
}
// Simulate the later core's prepared canonical agent activity and Ask candidate,
// not its transition implementation. P1.1 independently tests transitions.
fn ask(session: &Session, n: u64) -> Session {
    let mut staged = session.clone();
    let cause = id(100 + n);
    let mut activity = staged.messages[0].clone();
    activity.id = cause.clone();
    activity.number = staged.counters.next_message;
    activity.body = format!("Asked round {n}.\nExplicit agent activity.");
    activity.items_touched = vec![item("1")];
    staged.counters.next_message = p(activity.number.value() + 1);
    staged.messages.push(activity);
    let mut candidate = staged.items.0[&item("1")].clone();
    candidate.revision = p(candidate.revision.value() + 1);
    candidate.question_revision = p(candidate.question_revision.value() + 1);
    candidate.status = ItemStatus::WaitingOnMe;
    candidate.owner = ItemOwner::Me {};
    candidate.ask = Some(format!(
        "Choose the approach for round {n}.\nPreserve this request."
    ));
    candidate.options = options(n);
    candidate.current_round_id = Some(id(200 + n));
    candidate.recipient_binding_id = Some(id(3));
    candidate.waiting_since = Some(at());
    candidate.updated_at = at();
    candidate.updated_message_ids.push(cause.clone());
    open_ask_round(&staged, candidate, &cause, at()).unwrap()
}
// Queue fixtures are canonical caller-prepared inputs. History is not responsible
// for constructing these DTOs or advancing the input queue.
fn prepare_owner(
    session: &Session,
    item_id: ItemRef,
    n: u64,
    kind: InputKind,
    body: &str,
    selected: Option<String>,
    supersedes: Option<UuidV4>,
) -> (Session, Message, Option<Answer>, Option<UuidV4>) {
    let mut staged = session.clone();
    let target = &session.items.0[&item_id];
    let fresh_round = if target.current_round_id.is_none() {
        Some(id(700 + n))
    } else {
        None
    };
    let round = fresh_round
        .clone()
        .or_else(|| target.current_round_id.clone());
    let answer_id = (kind == InputKind::Answer).then(|| id(500 + n));
    let input = Input {
        id: id(400 + n),
        seq: session.counters.next_input,
        binding_id: id(3),
        kind: kind.clone(),
        target: InputTarget {
            topic_id: target.topic_id.clone(),
            item_id: Some(item_id.clone()),
        },
        message_id: id(300 + n),
        answer_id: answer_id.clone(),
        created_at: at(),
        expected_question_revision: (kind == InputKind::Answer).then_some(target.question_revision),
        payload: InputPayload {
            text: body.into(),
            intent: kind.clone(),
            target_snapshot: InputTargetSnapshot {
                topic_name: session.topics.0[&target.topic_id].name.clone(),
                item_question: Some(target.question.clone()),
                question_revision: Some(target.question_revision),
                ask: target.ask.clone(),
                options: target.options.clone(),
            },
            selected_option_id: selected.clone(),
            context: InputContext {
                message_ids: vec![],
                item_ids: vec![item_id.clone()],
                round_id: round.clone(),
                continuation_operation_id: None,
            },
        },
        state: InputState::Queued,
        attempts: vec![],
        active_attempt_id: None,
        resolution_history: vec![],
    };
    let message = Message {
        id: input.message_id.clone(),
        number: session.counters.next_message,
        author: MessageAuthor::Owner,
        kind: MessageKind::OwnerInput,
        body: body.into(),
        created_at: at(),
        item_id: Some(item_id.clone()),
        topic_id: Some(target.topic_id.clone()),
        items_touched: vec![],
        binding_id: Some(id(3)),
        input_id: Some(input.id.clone()),
        attempt_id: None,
        host_turn_id: None,
        round_id: round,
        origin: None,
    };
    let answer = answer_id.map(|id| Answer {
        id,
        seq: session.counters.next_answer,
        item_id,
        question_revision: target.question_revision,
        question_snapshot: target.question.clone(),
        ask_snapshot: target.ask.clone(),
        options_snapshot: target.options.clone(),
        selected_option_id: selected,
        text: body.into(),
        message_id: message.id.clone(),
        input_id: input.id.clone(),
        supersedes_answer_id: supersedes,
        created_at: at(),
    });
    staged.counters.next_input = p(input.seq.value() + 1);
    staged.inputs.0.insert(input.id.clone(), input);
    (staged, message, answer, fresh_round)
}
fn record(
    session: &Session,
    item_id: ItemRef,
    n: u64,
    kind: InputKind,
    body: &str,
    selected: Option<String>,
    supersedes: Option<UuidV4>,
) -> Session {
    let (staged, message, answer, round) =
        prepare_owner(session, item_id, n, kind, body, selected, supersedes);
    record_owner_history(&staged, message, answer, round).unwrap()
}
fn attempt(n: u64) -> Attempt {
    Attempt {
        id: id(600 + n),
        purpose: AttemptPurpose::Work,
        repair_for_attempt_id: None,
        claim_request_id: id(800 + n),
        binding_generation: id(4),
        prepared_at: at(),
        formatted_payload: format!("Exact input {n}.\nFull immutable submitted context."),
        payload_sha256: Sha256::new("a".repeat(64)).unwrap(),
        wire_marker: format!("[INPUT:{n}]"),
        acceptance: AcceptanceState::Accepted,
        acceptance_receipt: Some(HostReceipt {
            provider_reference: format!("accepted-{n}"),
            observed_at: at(),
        }),
        acceptance_observed_at: Some(at()),
        host_turn_id: Some(format!("turn-{n}")),
        turn_state: TurnState::Running,
        turn_observed_at: Some(at()),
        domain_result: None,
        result_state: ResultState::Pending,
        sealed_at: None,
        error: None,
        reconciliation_checkpoint: None,
    }
}
fn stage_attempt(mut session: Session, n: u64) -> Session {
    let input = session.inputs.0.get_mut(&id(400 + n)).unwrap();
    input.attempts.push(attempt(n));
    input.active_attempt_id = Some(id(600 + n));
    input.state = InputState::InFlight;
    session
        .bindings
        .0
        .get_mut(&id(3))
        .unwrap()
        .issued_through_message_number =
        NonnegativeSafeInteger::new(session.messages.last().unwrap().number.value()).unwrap();
    session
}
fn source(n: u64) -> AgentHistoryContext {
    AgentHistoryContext {
        source_input_id: Some(id(400 + n)),
        attempt_id: Some(id(600 + n)),
        ..context()
    }
}
fn reply(
    session: &Session,
    n: u64,
    target: &str,
    round: Option<UuidV4>,
    message_n: u64,
) -> Session {
    append_reply(session,&source(n),ReplyDraft{message_id:id(900+message_n),item_id:item(target),text:format!("Full explicit reply {message_n} to {target}.\nThe complete second paragraph stays available."),round_id:round,at:at()}).unwrap()
}
fn commit_result(
    mut session: Session,
    n: u64,
    replies: Vec<UuidV4>,
    children: Vec<ItemRef>,
) -> Session {
    let input = session.inputs.0.get_mut(&id(400 + n)).unwrap();
    let attempt = input.attempts.last_mut().unwrap();
    attempt.domain_result = Some(DomainResult {
        operation_id: id(1000 + n),
        outcome: ResultOutcome::Answered,
        explanation: format!("Explicit result {n}."),
        reply_message_ids: replies,
        followup_item_ids: children,
        handled_through_message_number: session.bindings.0[&id(3)].issued_through_message_number,
        committed_revision: p(1),
        committed_at: at(),
    });
    attempt.result_state = ResultState::Committed;
    session
}

#[test]
fn owner_messages_include_terminal_items_without_status_mutation() {
    let original = seed();
    for (n, kind) in [
        InputKind::Bring,
        InputKind::Reply,
        InputKind::Note,
        InputKind::Followup,
        InputKind::Reopen,
        InputKind::Drop,
    ]
    .into_iter()
    .enumerate()
    {
        let stored = record(
            &original,
            item("2"),
            n as u64 + 1,
            kind,
            "Full owner text.\nFollow the original reference.",
            None,
            None,
        );
        let target = &stored.items.0[&item("2")];
        assert_eq!(target.status, ItemStatus::Done);
        assert_eq!(target.outcome, original.items.0[&item("2")].outcome);
        assert_eq!(target.question_revision, p(1));
        assert_eq!(target.revision, p(2));
        assert_eq!(
            stored.messages.last().unwrap().body,
            "Full owner text.\nFollow the original reference."
        );
        assert_eq!(
            stored.messages.last().unwrap().items_touched,
            vec![item("2")]
        );
        assert_eq!(
            stored.rounds.0[&id(701 + n as u64)].owner_message_ids,
            vec![id(301 + n as u64)]
        );
        assert_eq!(
            stored.inputs.0.values().next().unwrap().state,
            InputState::Queued
        );
        validate_session_history(&stored).unwrap();
    }
    assert_eq!(original, seed());
}

#[test]
fn immutable_answers_preserve_option_only_selection_and_corrections() {
    let asked = ask(&seed(), 1);
    let first = record(
        &asked,
        item("1"),
        1,
        InputKind::Answer,
        " \n",
        Some("option-1".into()),
        None,
    );
    let corrected = record(
        &first,
        item("1"),
        2,
        InputKind::Answer,
        "Correction.\nKeep both versions.",
        Some("option-1".into()),
        Some(id(501)),
    );
    assert_eq!(corrected.answers[0], first.answers[0]);
    assert_eq!(corrected.answers[1].supersedes_answer_id, Some(id(501)));
    assert_eq!(corrected.answers[0].text, " \n");
    assert_eq!(corrected.messages[2].body, " \n");
    validate_session_history(&corrected).unwrap();
    let second_round = ask(&corrected, 2);
    assert_eq!(second_round.rounds.0[&id(201)].options_snapshot, options(1));
    assert_eq!(second_round.answers, corrected.answers);
    assert_eq!(
        second_round.messages[..corrected.messages.len()],
        corrected.messages
    );
    assert!(second_round.rounds.0[&id(201)].closed_at.is_some());
    let (staged, message, answer, round) = prepare_owner(
        &second_round,
        item("1"),
        3,
        InputKind::Answer,
        "New answer",
        Some("option-2".into()),
        Some(id(502)),
    );
    assert_eq!(
        record_owner_history(&staged, message, answer, round),
        Err(HistoryError::InvalidCorrection)
    );
}

#[test]
fn rejected_owner_records_leave_the_staged_candidate_unchanged() {
    let asked = ask(&seed(), 1);
    for case in 0..9 {
        let (mut staged, mut message, mut answer, round) = prepare_owner(
            &asked,
            item("1"),
            1,
            InputKind::Answer,
            "Complete answer",
            Some("option-1".into()),
            None,
        );
        match case {
            0 => message.body = "Changed text".into(),
            1 => message.number = p(99),
            2 => answer.as_mut().unwrap().selected_option_id = Some("missing".into()),
            3 => answer.as_mut().unwrap().question_revision = p(99),
            4 => answer.as_mut().unwrap().question_snapshot = "Other question".into(),
            5 => staged.state = SessionState::Closed,
            6 => staged.topics.0.get_mut(&id(5)).unwrap().archived_at = Some(at()),
            7 => staged.active_binding_id = None,
            _ => message.attempt_id = Some(id(600)),
        }
        let saved = staged.clone();
        assert!(record_owner_history(&staged, message, answer, round).is_err());
        assert_eq!(staged, saved);
    }
    for text in ["", " \n", "nul\0text", &"é".repeat(8193)] {
        let (staged, message, answer, round) =
            prepare_owner(&seed(), item("2"), 1, InputKind::Followup, text, None, None);
        assert!(record_owner_history(&staged, message, answer, round).is_err());
    }
}

fn child(mut session: Session, n: u64) -> Session {
    let ordinal = session.items.0[&item("1")].next_child;
    let mut created = seed().items.0[&item("1")].clone();
    created.id = item(&format!("1.{}", ordinal.value()));
    created.ordinal = ordinal;
    created.parent = Some(item("1"));
    created.question = format!("Follow-up fork from round {n}?");
    created.created_message_id = id(1100 + n);
    let mut cause = session.messages[0].clone();
    cause.id = id(1100 + n);
    cause.number = session.counters.next_message;
    cause.body = format!(
        "Created child {} from the explicit round.",
        created.id.as_str()
    );
    cause.items_touched = vec![item("1"), created.id.clone()];
    cause.input_id = Some(id(400 + n));
    cause.attempt_id = Some(id(600 + n));
    cause.host_turn_id = Some(format!("turn-{n}"));
    session.counters.next_message = p(cause.number.value() + 1);
    session.messages.push(cause);
    session.items.0.get_mut(&item("1")).unwrap().next_child = p(ordinal.value() + 1);
    session.items.0.insert(created.id.clone(), created.clone());
    link_round_fork(&session, &id(200 + n), &created.id, at()).unwrap()
}

#[test]
fn five_round_multi_item_fixture_retains_every_body_snapshot_and_fork() {
    let scenario: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/domain/history/five-rounds.json"
    ))
    .unwrap();
    let mut session = seed();
    let mut saved_bodies = vec![session.messages[0].body.clone()];
    for n in 1..=5 {
        session = ask(&session, n);
        let text = scenario["rounds"][(n - 1) as usize]["owner_text"]
            .as_str()
            .unwrap();
        session = record(
            &session,
            item("1"),
            n,
            InputKind::Answer,
            text,
            Some(format!("option-{n}")),
            None,
        );
        if n == 2 {
            session = record(
                &session,
                item("1"),
                6,
                InputKind::Answer,
                "Corrected selection explanation.\nThe earlier answer stays intact.",
                Some("option-2".into()),
                Some(id(502)),
            );
        }
        session = stage_attempt(session, n);
        session = reply(&session, n, "1", None, n);
        let mut replies = vec![id(900 + n)];
        let mut children = vec![];
        if n == 2 || n == 4 {
            session = child(session, n);
            let child_id = if n == 2 { "1.1" } else { "1.2" };
            session = reply(&session, n, child_id, None, 10 + n);
            replies.push(id(910 + n));
            children.push(item(child_id));
        }
        session = commit_result(session, n, replies, children);
        let before = session.clone();
        session = link_result_history(&session, &id(400 + n), &id(600 + n), &[], at()).unwrap();
        assert_eq!(session.inputs, before.inputs);
        assert!(session.rounds.0[&id(200 + n)].closed_at.is_none());
        validate_session_history(&session).unwrap();
        saved_bodies.extend(
            session.messages[saved_bodies.len()..]
                .iter()
                .map(|m| m.body.clone()),
        );
    }
    session = record(
        &session,
        item("2"),
        7,
        InputKind::Followup,
        scenario["closed_item_message"].as_str().unwrap(),
        None,
        None,
    );
    assert_eq!(session.items.0[&item("2")].status, ItemStatus::Done);
    assert_eq!(
        session
            .rounds
            .0
            .values()
            .filter(|r| r.item_id == item("1"))
            .count(),
        5
    );
    assert_eq!(session.rounds.0[&id(202)].fork_item_ids, vec![item("1.1")]);
    assert_eq!(session.items.0[&item("1.2")].source_round_id, Some(id(204)));
    assert_eq!(session.answers.len(), 6);
    for n in 1..=5 {
        let round = &session.rounds.0[&id(200 + n)];
        assert_eq!(round.ordinal, p(n));
        assert_eq!(round.options_snapshot, options(n));
        assert_eq!(round.result_input_ids, vec![id(400 + n)]);
        assert_eq!(round.closed_at.is_some(), n < 5);
        let reply = session
            .messages
            .iter()
            .find(|m| m.id == id(900 + n))
            .unwrap();
        assert_eq!(reply.binding_id, Some(id(3)));
        assert_eq!(reply.input_id, Some(id(400 + n)));
        assert_eq!(reply.attempt_id, Some(id(600 + n)));
        assert_eq!(reply.host_turn_id, Some(format!("turn-{n}")));
        assert_eq!(reply.round_id, Some(id(200 + n)));
    }
    assert_eq!(
        session.messages[..saved_bodies.len()]
            .iter()
            .map(|m| m.body.clone())
            .collect::<Vec<_>>(),
        saved_bodies
    );
    let emitted = serde_json::to_vec(&session).unwrap();
    let reloaded: Session = serde_json::from_slice(&emitted).unwrap();
    assert_eq!(reloaded, session);
    validate_session_history(&reloaded).unwrap();
    assert!(session.messages.iter().all(|m| m.origin.is_none()));
}

#[test]
fn close_and_explicit_historical_replies_never_reopen_a_round() {
    let mut session = ask(&seed(), 1);
    let original_revision = session.items.0[&item("1")].revision;
    session = close_round(&session, &id(201), at()).unwrap();
    assert_eq!(session.items.0[&item("1")].current_round_id, None);
    assert_eq!(
        session.items.0[&item("1")].revision,
        p(original_revision.value() + 1)
    );
    assert_eq!(
        close_round(
            &session,
            &id(201),
            UtcMillis::new("2026-10-04T12:00:00.000Z").unwrap()
        )
        .unwrap(),
        session
    );
    let replied = append_reply(
        &session,
        &context(),
        ReplyDraft {
            message_id: id(900),
            item_id: item("1"),
            text: "A late explicit reply.\nFull body.".into(),
            round_id: Some(id(201)),
            at: at(),
        },
    )
    .unwrap();
    assert_eq!(replied.rounds.0[&id(201)].closed_at, Some(at()));
    assert_eq!(replied.items.0[&item("1")].current_round_id, None);
    let next = record(
        &replied,
        item("1"),
        1,
        InputKind::Followup,
        "Continue the discussion.",
        None,
        None,
    );
    assert_eq!(next.rounds.0[&id(701)].ordinal, p(2));
    assert_eq!(next.rounds.0[&id(201)].closed_at, Some(at()));
    validate_session_history(&next).unwrap();
}

#[test]
fn replies_require_exact_binding_attempt_and_round_provenance() {
    let queued = record(
        &ask(&seed(), 1),
        item("1"),
        1,
        InputKind::Answer,
        "Selection explanation",
        None,
        None,
    );
    let session = stage_attempt(queued, 1);
    let draft = ReplyDraft {
        message_id: id(900),
        item_id: item("1"),
        text: "Explicit reply".into(),
        round_id: None,
        at: at(),
    };
    for n in 0..9 {
        let mut candidate = session.clone();
        let mut ctx = source(1);
        let mut draft = draft.clone();
        match n {
            0 => ctx.binding_id = id(99),
            1 => ctx.generation = id(99),
            2 => ctx.attempt_id = None,
            3 => candidate.inputs.0.get_mut(&id(401)).unwrap().binding_id = id(99),
            4 => candidate.inputs.0.get_mut(&id(401)).unwrap().attempts[0].sealed_at = Some(at()),
            5 => draft.item_id = item("99"),
            6 => draft.round_id = Some(id(99)),
            7 => draft.text = " \n".into(),
            _ => {
                candidate
                    .bindings
                    .0
                    .get_mut(&id(3))
                    .unwrap()
                    .connection_state = ConnectionState::Disconnected
            }
        }
        let saved = candidate.clone();
        assert!(append_reply(&candidate, &ctx, draft).is_err());
        assert_eq!(candidate, saved);
    }
    let stored = append_reply(&session, &source(1), draft.clone()).unwrap();
    assert_eq!(stored.inputs, session.inputs);
    assert_eq!(
        stored.items.0[&item("1")].question_revision,
        session.items.0[&item("1")].question_revision
    );
    assert_eq!(
        append_reply(&stored, &source(1), draft),
        Err(HistoryError::DuplicateId)
    );
    let wrong = ReplyDraft {
        message_id: id(901),
        item_id: item("2"),
        text: "Reply".into(),
        round_id: Some(id(201)),
        at: at(),
    };
    assert_eq!(
        append_reply(&session, &source(1), wrong),
        Err(HistoryError::InvalidRound)
    );
}

#[test]
fn result_links_close_only_explicit_rounds_and_do_not_commit_or_seal() {
    let session = stage_attempt(
        record(
            &ask(&seed(), 1),
            item("1"),
            1,
            InputKind::Answer,
            "Owner answer",
            None,
            None,
        ),
        1,
    );
    assert_eq!(
        link_result_history(&session, &id(401), &id(601), &[], at()),
        Err(HistoryError::MissingReference)
    );
    let replied = reply(&session, 1, "1", None, 1);
    let committed = commit_result(replied, 1, vec![id(901)], vec![]);
    let linked = link_result_history(&committed, &id(401), &id(601), &[], at()).unwrap();
    assert_eq!(linked.rounds.0[&id(201)].result_input_ids, vec![id(401)]);
    assert!(linked.rounds.0[&id(201)].closed_at.is_none());
    assert_eq!(
        link_result_history(&linked, &id(401), &id(601), &[], at()).unwrap(),
        linked
    );
    let closed = link_result_history(&linked, &id(401), &id(601), &[id(201)], at()).unwrap();
    assert_eq!(closed.inputs, committed.inputs);
    assert_eq!(closed.rounds.0[&id(201)].closed_at, Some(at()));
    assert_eq!(
        link_result_history(&committed, &id(401), &id(601), &[id(99)], at()),
        Err(HistoryError::InvalidRound)
    );
    assert_eq!(
        append_reply(
            &committed,
            &source(1),
            ReplyDraft {
                message_id: id(999),
                item_id: item("1"),
                text: "Additional mutation".into(),
                round_id: None,
                at: at()
            }
        ),
        Err(HistoryError::ResultAlreadyCommitted)
    );
    validate_session_history(&closed).unwrap();
}

#[test]
fn fork_links_are_bidirectional_idempotent_and_never_reassigned() {
    let session = child(
        stage_attempt(
            record(
                &ask(&seed(), 1),
                item("1"),
                1,
                InputKind::Answer,
                "Answer",
                None,
                None,
            ),
            1,
        ),
        1,
    );
    let same = link_round_fork(&session, &id(201), &item("1.1"), at()).unwrap();
    assert_eq!(same, session);
    let newer = ask(&session, 2);
    assert_eq!(
        link_round_fork(&newer, &id(202), &item("1.1"), at()),
        Err(HistoryError::InvalidRound)
    );
    assert_eq!(
        link_round_fork(&session, &id(201), &item("2"), at()),
        Err(HistoryError::InvalidRound)
    );
    validate_session_history(&newer).unwrap();
}

#[test]
fn canonical_shared_activity_is_not_copied_into_item_reply_lists() {
    let mut session = ask(&seed(), 1);
    let mut activity = session.messages[1].clone();
    activity.id = id(199);
    activity.number = session.counters.next_message;
    activity.round_id = Some(id(201));
    activity.items_touched = vec![item("1"), item("2")];
    session.counters.next_message = p(activity.number.value() + 1);
    session.messages.push(activity);
    validate_session_history(&session).unwrap();
    assert!(session.rounds.0[&id(201)].agent_message_ids.is_empty());
}

#[test]
fn stale_answers_require_generic_followup_and_history_keeps_reopened_outcomes() {
    let session = ask(&seed(), 1);
    let mut changed = session.clone();
    changed
        .items
        .0
        .get_mut(&item("1"))
        .unwrap()
        .question_revision = p(99);
    changed.items.0.get_mut(&item("1")).unwrap().question = "The revised release question?".into();
    let (staged, message, answer, round) = prepare_owner(
        &changed,
        item("1"),
        1,
        InputKind::Answer,
        "Answer",
        None,
        None,
    );
    assert_eq!(
        record_owner_history(&staged, message, answer, round),
        Err(HistoryError::QuestionChanged)
    );
    let followed = record(
        &changed,
        item("1"),
        1,
        InputKind::Followup,
        "Respond to the revised question.\nKeep it a generic follow-up.",
        None,
        None,
    );
    assert!(followed.answers.is_empty());
    assert_eq!(
        followed.rounds.0[&id(201)].question_snapshot,
        "Which release approach?"
    );
    let mut reopened = seed();
    let old = reopened.items.0[&item("2")].clone();
    let target = reopened.items.0.get_mut(&item("2")).unwrap();
    // A caller-prepared canonical reopen audit, whose transition is P1.1's job.
    target.status = ItemStatus::Open;
    target.outcome = None;
    target.why = None;
    target.status_history.push(StatusHistoryEntry {
        old_status: old.status,
        new_status: ItemStatus::Open,
        previous_outcome: old.outcome,
        previous_why: old.why,
        previous_replaced_by: None,
        cause_message_id: id(6),
        at: at(),
        binding_id: Some(id(3)),
        handled_through_message_number: NonnegativeSafeInteger::new(0).unwrap(),
        reason: Some("Revisit the original evidence.".into()),
    });
    let recorded = record(
        &reopened,
        item("2"),
        1,
        InputKind::Followup,
        "Discuss the reopened work.",
        None,
        None,
    );
    assert_eq!(
        recorded.items.0[&item("2")].status_history,
        reopened.items.0[&item("2")].status_history
    );
    assert_eq!(
        recorded.items.0[&item("2")].status_history[0]
            .previous_outcome
            .as_deref(),
        Some("Recorded original reference.")
    );
}

#[test]
fn counter_overflow_and_invalid_ask_candidates_have_no_partial_effects() {
    let mut exhausted = seed();
    exhausted.counters.next_message = p(9_007_199_254_740_991);
    assert_eq!(
        append_reply(
            &exhausted,
            &context(),
            ReplyDraft {
                message_id: id(900),
                item_id: item("1"),
                text: "Reply".into(),
                round_id: None,
                at: at()
            }
        ),
        Err(HistoryError::CounterOverflow)
    );
    let mut exhausted = ask(&seed(), 1);
    exhausted.counters.next_answer = p(9_007_199_254_740_991);
    let (staged, message, answer, round) = prepare_owner(
        &exhausted,
        item("1"),
        1,
        InputKind::Answer,
        "Answer",
        None,
        None,
    );
    assert_eq!(
        record_owner_history(&staged, message, answer, round),
        Err(HistoryError::CounterOverflow)
    );
    let mut exhausted = seed();
    exhausted.items.0.get_mut(&item("1")).unwrap().revision = p(9_007_199_254_740_991);
    assert_eq!(
        append_reply(
            &exhausted,
            &context(),
            ReplyDraft {
                message_id: id(900),
                item_id: item("1"),
                text: "Reply".into(),
                round_id: None,
                at: at()
            }
        ),
        Err(HistoryError::CounterOverflow)
    );
    let asked = ask(&seed(), 1);
    let candidate = asked.items.0[&item("1")].clone();
    assert_eq!(
        open_ask_round(&asked, candidate.clone(), &id(101), at()),
        Err(HistoryError::DuplicateId)
    );
    let mut wrong = candidate;
    wrong.current_round_id = Some(id(999));
    wrong.revision = p(wrong.revision.value() + 1);
    wrong.question_revision = p(wrong.question_revision.value() + 1);
    wrong.question = "Silently rewrite the question".into();
    assert_eq!(
        open_ask_round(&asked, wrong, &id(101), at()),
        Err(HistoryError::InvalidSnapshot)
    );
}

#[test]
fn result_repair_can_cite_verified_prior_effects_without_repeating_work() {
    let session = stage_attempt(
        record(
            &ask(&seed(), 1),
            item("1"),
            1,
            InputKind::Answer,
            "Answer",
            None,
            None,
        ),
        1,
    );
    let mut session = reply(&session, 1, "1", None, 1);
    let input = session.inputs.0.get_mut(&id(401)).unwrap();
    input.attempts[0].turn_state = TurnState::Completed;
    let mut repair = attempt(2);
    repair.purpose = AttemptPurpose::ResultRepair;
    repair.repair_for_attempt_id = Some(id(601));
    repair.domain_result = Some(DomainResult {
        operation_id: id(1002),
        outcome: ResultOutcome::Deferred,
        explanation: "Verified existing reply; work is deferred.".into(),
        reply_message_ids: vec![id(901)],
        followup_item_ids: vec![],
        handled_through_message_number: NonnegativeSafeInteger::new(3).unwrap(),
        committed_revision: p(1),
        committed_at: at(),
    });
    repair.result_state = ResultState::Committed;
    input.attempts.push(repair);
    input.active_attempt_id = Some(id(602));
    let linked = link_result_history(&session, &id(401), &id(602), &[], at()).unwrap();
    assert_eq!(linked.messages, session.messages);
    assert_eq!(linked.inputs, session.inputs);
    validate_session_history(&linked).unwrap();
    for n in 0..4 {
        let mut invalid = session.clone();
        let attempts = &mut invalid.inputs.0.get_mut(&id(401)).unwrap().attempts;
        match n {
            0 => attempts[0].turn_state = TurnState::Running,
            1 => attempts[1].repair_for_attempt_id = Some(id(99)),
            2 => attempts[1].purpose = AttemptPurpose::Work,
            _ => attempts[1]
                .domain_result
                .as_mut()
                .unwrap()
                .reply_message_ids
                .clear(),
        }
        assert!(link_result_history(&invalid, &id(401), &id(602), &[], at()).is_err());
    }
}

#[test]
fn history_validator_rejects_broken_links_and_superseded_payload_rewrites() {
    let session = record(
        &ask(&seed(), 1),
        item("1"),
        1,
        InputKind::Answer,
        "Complete answer",
        Some("option-1".into()),
        None,
    );
    for n in 0..12 {
        let mut broken = session.clone();
        match n {
            0 => broken.messages.push(broken.messages[0].clone()),
            1 => broken.messages[2].number = p(1),
            2 => broken
                .rounds
                .0
                .get_mut(&id(201))
                .unwrap()
                .owner_message_ids
                .clear(),
            3 => broken.answers[0].text = "Rewritten accepted answer".into(),
            4 => broken.answers[0].selected_option_id = Some("invalid".into()),
            5 => broken.answers[0].question_snapshot = "Other question".into(),
            6 => broken.answers[0].supersedes_answer_id = Some(id(99)),
            7 => broken.items.0.get_mut(&item("1")).unwrap().current_round_id = Some(id(99)),
            8 => broken
                .items
                .0
                .get_mut(&item("1"))
                .unwrap()
                .updated_message_ids
                .push(id(99)),
            9 => broken.messages[2].binding_id = Some(id(99)),
            10 => broken
                .rounds
                .0
                .get_mut(&id(201))
                .unwrap()
                .result_input_ids
                .push(id(401)),
            _ => broken
                .rounds
                .0
                .get_mut(&id(201))
                .unwrap()
                .fork_item_ids
                .push(item("2")),
        }
        assert!(
            validate_session_history(&broken).is_err(),
            "accepted corrupt case {n}"
        );
    }
}

#[test]
fn history_message_lookup_preserves_duplicate_and_item_error_precedence() {
    let mut session = seed();
    session.messages.push(session.messages[0].clone());
    session.messages[0].body.clear();
    session
        .items
        .0
        .get_mut(&item("1"))
        .unwrap()
        .created_message_id = id(99);
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::DuplicateId)
    );

    let mut session = seed();
    let first = session.items.0.get_mut(&item("1")).unwrap();
    first.created_message_id = id(99);
    first.updated_message_ids = vec![id(98), id(98)];
    session.messages[0].items_touched = vec![item("1")];
    // The first item's missing creation precedes duplicate updates and the
    // later item's invalid creation provenance.
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::MissingReference)
    );
    session
        .items
        .0
        .get_mut(&item("1"))
        .unwrap()
        .created_message_id = id(6);
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::DuplicateId)
    );
    session
        .items
        .0
        .get_mut(&item("1"))
        .unwrap()
        .updated_message_ids = vec![id(99)];
    session.messages[0].items_touched = vec![item("2")];
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::InvalidProvenance)
    );
}

#[test]
fn history_message_lookup_tracks_current_ids_and_preserves_round_checks() {
    let mut session = seed();
    validate_session_history(&session).unwrap();
    session.messages[0].id = id(7);
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::MissingReference)
    );
    for target in session.items.0.values_mut() {
        target.created_message_id = id(7);
    }
    validate_session_history(&session).unwrap();

    let mut session = ask(&seed(), 1);
    let round = session.rounds.0.get_mut(&id(201)).unwrap();
    round.opened_message_id = id(99);
    round.owner_message_ids = vec![id(6), id(6)];
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::MissingReference)
    );
    session
        .rounds
        .0
        .get_mut(&id(201))
        .unwrap()
        .opened_message_id = id(101);
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::DuplicateId)
    );
    // The valid creation Activity touches the round's item but is not an
    // owner conversation entry; that error precedes a later missing message.
    session
        .rounds
        .0
        .get_mut(&id(201))
        .unwrap()
        .owner_message_ids = vec![id(6), id(99)];
    assert_eq!(
        validate_session_history(&session),
        Err(HistoryError::InvalidRound)
    );
}

#[test]
fn canonical_demo_and_source_snapshots_validate_history_without_invented_rules() {
    for fixture in [
        include_str!("../../../fixtures/domain/demo/session.json"),
        include_str!("../../../fixtures/domain/demo/source-session.json"),
    ] {
        let session: Session = serde_json::from_str(fixture).unwrap();
        validate_session_history(&session).unwrap();
    }
}

fn copied_history() -> Session {
    let mut session = record(
        &ask(&seed(), 1),
        item("1"),
        1,
        InputKind::Answer,
        "",
        Some("option-1".into()),
        None,
    );
    let project = id(1501);
    let source_session = id(1502);
    let topic = id(1505);
    let source_revision = p(12);
    let mut message_map = std::collections::BTreeMap::new();
    for message in &mut session.messages {
        let source = id(1600 + message.number.value());
        message_map.insert(source.clone(), message.id.clone());
        message.origin = Some(MessageOrigin {
            source_target: MessageSourceTarget {
                project_id: project.clone(),
                session_id: source_session.clone(),
                topic_id: Some(topic.clone()),
                item_id: message.item_id.clone(),
                round_id: message.round_id.as_ref().map(|_| id(1701)),
            },
            project_id: project.clone(),
            session_id: source_session.clone(),
            topic_id: topic.clone(),
            entity_id: source,
            source_revision,
            author: message.author.clone(),
            binding_id: Some(id(1599)),
            adapter_id: Some("source.adapter".into()),
            external_session_id: Some("source-thread".into()),
        });
        message.binding_id = Some(id(1599));
    }
    session.topics.0.get_mut(&id(5)).unwrap().origin = Some(TopicOrigin {
        project_id: project.clone(),
        session_id: source_session.clone(),
        topic_id: topic.clone(),
        source_revision,
        continued_at: at(),
    });
    for target in session.items.0.values_mut() {
        target.origin = Some(ItemOrigin {
            project_id: project.clone(),
            session_id: source_session.clone(),
            topic_id: topic.clone(),
            entity_id: target.id.clone(),
            source_revision,
        });
    }
    let round = session.rounds.0.get_mut(&id(201)).unwrap();
    round.origin = Some(RoundOrigin {
        project_id: project.clone(),
        session_id: source_session.clone(),
        topic_id: topic.clone(),
        entity_id: id(1701),
        source_revision,
    });
    round.result_input_ids = vec![id(401)];
    session.inputs.0.clear();
    let receipt = ContinuationReceipt {
        operation_id: id(1801),
        source_project_id: project,
        source_session_id: source_session,
        source_topic_id: topic,
        source_revision,
        source_sha256: Sha256::new("b".repeat(64)).unwrap(),
        target_topic_id: id(5),
        target_input_id: id(1802),
        item_id_map: UniqueMap(std::collections::BTreeMap::from([
            (item("1"), item("1")),
            (item("2"), item("2")),
        ])),
        message_id_map: UniqueMap(message_map),
        round_id_map: UniqueMap(std::collections::BTreeMap::from([(id(1701), id(201))])),
        answer_id_map: UniqueMap(std::collections::BTreeMap::from([(id(1751), id(501))])),
        summary: "Confirmed complete source context.".into(),
        confirmed_at: at(),
    };
    session
        .continuations
        .0
        .insert(receipt.operation_id.clone(), receipt);
    session
}

#[test]
fn copied_answers_and_round_results_remain_source_history_without_target_inputs() {
    let copied = copied_history();
    validate_session_history(&copied).unwrap();
    assert!(copied.inputs.0.is_empty());
    assert_eq!(copied.answers[0].input_id, id(401));
    assert_eq!(copied.messages[2].binding_id, Some(id(1599)));
    assert!(!copied.bindings.0.contains_key(&id(1599)));
    for n in 0..10 {
        let mut invalid = copied.clone();
        match n {
            0 => invalid.continuations.0.clear(),
            1 => invalid.messages[2].origin.as_mut().unwrap().project_id = id(99),
            2 => invalid.messages[2].origin.as_mut().unwrap().source_revision = p(99),
            3 => invalid.messages[2].binding_id = Some(id(3)),
            4 => invalid.messages[2].author = MessageAuthor::Agent,
            5 => invalid.topics.0.get_mut(&id(5)).unwrap().origin = None,
            6 => {
                invalid
                    .rounds
                    .0
                    .get_mut(&id(201))
                    .unwrap()
                    .origin
                    .as_mut()
                    .unwrap()
                    .entity_id = id(99)
            }
            7 => {
                invalid
                    .items
                    .0
                    .get_mut(&item("1"))
                    .unwrap()
                    .origin
                    .as_mut()
                    .unwrap()
                    .entity_id = item("9")
            }
            8 => invalid.answers[0].question_snapshot = "Invented source question".into(),
            _ => invalid.answers[0].selected_option_id = Some("invented-option".into()),
        }
        assert!(
            validate_session_history(&invalid).is_err(),
            "accepted invalid copied case {n}"
        );
    }
}

#[test]
fn original_answer_inputs_require_their_complete_canonical_answer_links() {
    let session = record(
        &ask(&seed(), 1),
        item("1"),
        1,
        InputKind::Answer,
        "Nonblank accepted answer",
        Some("option-1".into()),
        None,
    );
    for case in 0..8 {
        let mut broken = session.clone();
        match case {
            0 => broken.answers.clear(),
            1 => broken.inputs.0.get_mut(&id(401)).unwrap().answer_id = None,
            2 => broken.inputs.0.get_mut(&id(401)).unwrap().answer_id = Some(id(99)),
            3 => broken.answers[0].input_id = id(99),
            4 => broken.answers[0].message_id = id(6),
            5 => broken.answers[0].item_id = item("2"),
            6 => broken.inputs.0.get_mut(&id(401)).unwrap().kind = InputKind::Reply,
            _ => broken.answers[0].options_snapshot.clear(),
        }
        assert!(
            validate_session_history(&broken).is_err(),
            "accepted broken answer link {case}"
        );
    }
    let mut generic = record(
        &seed(),
        item("2"),
        1,
        InputKind::Followup,
        "Generic message",
        None,
        None,
    );
    generic.inputs.0.get_mut(&id(401)).unwrap().answer_id = Some(id(99));
    assert_eq!(
        validate_session_history(&generic),
        Err(HistoryError::InvalidAnswer)
    );
}

#[test]
fn ordinary_updates_to_existing_items_are_not_result_followup_creation() {
    let queued = record(
        &ask(&seed(), 1),
        item("1"),
        1,
        InputKind::Answer,
        "Owner answer",
        None,
        None,
    );
    let active = stage_attempt(queued, 1);
    let updated = reply(&active, 1, "2", None, 1);
    assert_eq!(updated.items.0[&item("2")].created_message_id, id(6));
    assert_eq!(updated.items.0[&item("2")].source_round_id, None);
    assert!(updated.items.0[&item("2")]
        .updated_message_ids
        .contains(&id(901)));
    let result = commit_result(updated, 1, vec![], vec![item("2")]);
    assert_eq!(
        link_result_history(&result, &id(401), &id(601), &[], at()),
        Err(HistoryError::InvalidProvenance)
    );
    assert_eq!(
        validate_session_history(&result),
        Err(HistoryError::InvalidProvenance)
    );
    // Forging a result backlink must not make the ordinary update legitimate.
    let mut linked = result.clone();
    linked
        .rounds
        .0
        .get_mut(&id(201))
        .unwrap()
        .result_input_ids
        .push(id(401));
    assert_eq!(
        validate_session_history(&linked),
        Err(HistoryError::InvalidProvenance)
    );
}

#[test]
fn results_accept_earlier_same_input_creation_and_verified_repair_created_children() {
    let active = stage_attempt(
        record(
            &ask(&seed(), 1),
            item("1"),
            1,
            InputKind::Answer,
            "Owner answer",
            None,
            None,
        ),
        1,
    );
    let created = child(active, 1);
    let later = reply(&created, 1, "1", None, 1);
    let result = commit_result(later, 1, vec![], vec![item("1.1")]);
    let linked = link_result_history(&result, &id(401), &id(601), &[], at()).unwrap();
    validate_session_history(&linked).unwrap();
    // Repair cites the previously created child without repeating its creation.
    let mut repairable = created.clone();
    let input = repairable.inputs.0.get_mut(&id(401)).unwrap();
    input.attempts[0].turn_state = TurnState::Completed;
    let mut repair = attempt(2);
    repair.purpose = AttemptPurpose::ResultRepair;
    repair.repair_for_attempt_id = Some(id(601));
    repair.domain_result = Some(DomainResult {
        operation_id: id(1002),
        outcome: ResultOutcome::Answered,
        explanation: "Verified original created follow-up.".into(),
        reply_message_ids: vec![],
        followup_item_ids: vec![item("1.1")],
        handled_through_message_number: NonnegativeSafeInteger::new(3).unwrap(),
        committed_revision: p(1),
        committed_at: at(),
    });
    repair.result_state = ResultState::Committed;
    input.attempts.push(repair);
    input.active_attempt_id = Some(id(602));
    let repaired = link_result_history(&repairable, &id(401), &id(602), &[], at()).unwrap();
    assert_eq!(repaired.messages, repairable.messages);
    assert_eq!(repaired.items, repairable.items);
    validate_session_history(&repaired).unwrap();
    for case in 0..4 {
        let mut invalid = result.clone();
        match case {
            0 => invalid.items.0.get_mut(&item("1.1")).unwrap().parent = Some(item("2")),
            1 => invalid
                .rounds
                .0
                .get_mut(&id(201))
                .unwrap()
                .fork_item_ids
                .clear(),
            2 => {
                invalid
                    .messages
                    .iter_mut()
                    .find(|m| m.id == id(1101))
                    .unwrap()
                    .attempt_id = Some(id(99))
            }
            _ => {
                invalid
                    .messages
                    .iter_mut()
                    .find(|m| m.id == id(1101))
                    .unwrap()
                    .input_id = Some(id(99))
            }
        }
        assert!(link_result_history(&invalid, &id(401), &id(601), &[], at()).is_err());
        assert!(validate_session_history(&invalid).is_err());
    }
}

#[test]
fn imported_reply_direct_targets_are_qualified_and_map_checked() {
    let original: Session =
        serde_json::from_str(include_str!("../../../fixtures/domain/demo/session.json")).unwrap();
    validate_session_history(&original).unwrap();
    let original_reply = original
        .messages
        .iter()
        .position(|m| m.id == id(0x112))
        .unwrap();
    for variant in 0..4 {
        let mut invalid = original.clone();
        let route = &mut invalid.messages[original_reply]
            .origin
            .as_mut()
            .unwrap()
            .source_target;
        match variant {
            0 => route.item_id = Some(item("9")),
            1 => route.round_id = Some(id(999)),
            2 => route.session_id = id(999),
            _ => route.topic_id = Some(id(999)),
        }
        assert_eq!(
            validate_session_history(&invalid),
            Err(HistoryError::InvalidProvenance)
        );
    }
    let mut provenance = original;
    let mut message = provenance.messages[original_reply].clone();
    message.id = id(12000);
    message.number = provenance.counters.next_message;
    provenance.counters.next_message = p(message.number.value() + 1);
    message.item_id = None;
    message.topic_id = None;
    message.round_id = None;
    let origin = message.origin.as_mut().unwrap();
    origin.entity_id = id(12001);
    let route = &mut origin.source_target;
    route.item_id = Some(item("9"));
    route.topic_id = Some(id(999));
    route.round_id = None;
    let receipt = provenance
        .continuations
        .0
        .values_mut()
        .find(|r| {
            r.message_id_map
                .0
                .values()
                .any(|id| id == &provenance.messages[original_reply].id)
        })
        .unwrap();
    receipt
        .message_id_map
        .0
        .insert(origin.entity_id.clone(), message.id.clone());
    let original_reply = provenance.messages.len();
    provenance.messages.push(message);
    validate_session_history(&provenance).unwrap();
    ariadne_domain::validation::validate_session_items(&provenance).unwrap();
    for variant in 0..3 {
        let mut invalid = provenance.clone();
        let message = &mut invalid.messages[original_reply];
        match variant {
            0 => message.origin = None,
            1 => message.origin.as_mut().unwrap().entity_id = id(999),
            _ => message.origin.as_mut().unwrap().source_target.item_id = None,
        }
        assert!(validate_session_history(&invalid).is_err());
        assert!(ariadne_domain::validation::validate_session_items(&invalid).is_err());
    }
}
