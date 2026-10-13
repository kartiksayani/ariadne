//! Filing advice is derived locally; it is never part of a saved receipt.
use ariadne_core::{ApplyRequest, EntityRef, Operation};
use ariadne_domain::{models::*, visibility::item_is_removed};
use std::collections::BTreeSet;

pub(super) fn collect(
    before: &Session,
    after: &Session,
    request: &ApplyRequest,
    receipt: &SavedReceipt,
) -> Vec<String> {
    let created: BTreeSet<_> = match &receipt.data {
        SavedReceiptData::Apply { allocated_refs, .. } => allocated_refs
            .0
            .values()
            .filter_map(|allocated| match allocated {
                AllocatedRef::Item { id } => Some(id),
                _ => None,
            })
            .collect(),
        _ => BTreeSet::new(),
    };
    let existing: Vec<_> = before
        .items
        .0
        .values()
        .filter(|item| {
            visible(before, item)
                && !created.contains(&item.id)
                && !matches!(item.status, ItemStatus::Replaced | ItemStatus::Dropped)
        })
        .collect();
    let mut warnings = vec![];
    let mut mentioned = BTreeSet::new();
    let mut missing_reasons = BTreeSet::new();
    let mut prose = vec![request.summary.as_str()];
    if let Some(result) = &request.input_result {
        prose.push(&result.explanation);
    }
    for operation in &request.operations {
        match operation {
            Operation::ItemAdd(add) => {
                if let Some(item) = existing.iter().find(|item| {
                    similar(&add.question, &item.question)
                        || add.short.as_ref().is_some_and(|short| {
                            item.short.as_ref().is_some_and(|old| similar(short, old))
                        })
                }) {
                    warnings.push(format!(
                        "Possible duplicate of {} ({}). Update it or use item.replace.",
                        label(item),
                        item.id.as_str()
                    ));
                }
                prose.push(&add.question);
                prose.extend(add.note.as_deref());
                prose.extend(add.ask.as_deref());
                prose.extend(add.outcome.as_deref());
                prose.extend(add.why.as_deref());
            }
            Operation::ItemEdit {
                item,
                patch,
                reason,
                wording_only,
            } => {
                prose.extend(patch.question.as_deref());
                prose.extend(patch.note.as_ref().and_then(|note| note.as_deref()));
                if !wording_only && !has_text(reason.as_deref()) {
                    reason_warning(
                        before,
                        request,
                        item,
                        &created,
                        &mut missing_reasons,
                        &mut warnings,
                    );
                }
            }
            Operation::ItemStatus {
                item,
                outcome,
                why,
                reason,
                ..
            } => {
                prose.extend(outcome.as_deref());
                prose.extend(why.as_deref());
                if !has_text(reason.as_deref()) {
                    reason_warning(
                        before,
                        request,
                        item,
                        &created,
                        &mut missing_reasons,
                        &mut warnings,
                    );
                }
            }
            Operation::ItemAsk { ask, .. } => prose.push(ask),
            Operation::ItemReplace { outcome, why, .. } => {
                prose.push(outcome);
                prose.push(why);
            }
            Operation::Reply { text, .. } => prose.push(text),
            Operation::TopicAdd { brief, .. } => prose.extend(brief.as_deref()),
            Operation::TopicEdit { brief, .. } => {
                prose.extend(brief.as_ref().and_then(|brief| brief.as_deref()));
            }
            _ => {}
        }
    }
    let live: Vec<_> = after
        .items
        .0
        .values()
        .filter(|item| visible(after, item))
        .collect();
    for text in prose {
        for number in bare_numbers(text) {
            if let Some(item) = live.iter().find(|item| item.id.as_str() == number) {
                if mentioned.insert(item.id.clone()) {
                    warnings.push(format!(
                        "Bare item number {}. Use a named link: [{}](item:{}).",
                        item.id.as_str(),
                        label(item),
                        item.id.as_str()
                    ));
                }
            }
        }
    }
    if after.state == SessionState::Active {
        let waiting = live
            .iter()
            .filter(|item| ariadne_core::queries::waiting_unanswered(after, item))
            .count();
        if waiting > 3 {
            warnings.push(format!(
                "{waiting} items are waiting on the owner. Finish or withdraw old questions."
            ));
        }
    }
    for topic in after
        .topics
        .0
        .values()
        .filter(|topic| topic.removed_at.is_none() && topic.archived_at.is_none())
    {
        if !has_text(topic.brief.as_deref())
            && live.iter().filter(|item| item.topic_id == topic.id).count() >= 3
        {
            warnings.push(format!(
                "Topic {} ({}) has at least 3 items and no brief. Add one with topic.edit.",
                topic.name.split_whitespace().collect::<Vec<_>>().join(" "),
                topic.order.value()
            ));
        }
    }
    warnings
}

fn visible(session: &Session, item: &Item) -> bool {
    !item_is_removed(session, item)
        && session
            .topics
            .0
            .get(&item.topic_id)
            .is_some_and(|topic| topic.archived_at.is_none())
}

fn has_text(text: Option<&str>) -> bool {
    text.is_some_and(|text| !text.trim().is_empty())
}

fn label(item: &Item) -> String {
    item.short
        .as_deref()
        .unwrap_or(&item.question)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['[', ']'], "")
        .chars()
        .take(80)
        .collect()
}

fn reason_warning(
    before: &Session,
    request: &ApplyRequest,
    target: &EntityRef,
    created: &BTreeSet<&ItemRef>,
    mentioned: &mut BTreeSet<ItemRef>,
    warnings: &mut Vec<String>,
) {
    let EntityRef::Existing(target) = target else {
        return;
    };
    if request.source_input_id.is_some()
        && !created.contains(&target.id)
        && before.items.0.contains_key(&target.id)
        && mentioned.insert(target.id.clone())
    {
        warnings.push(format!(
            "Item {} changed while handling owner input without a reason. Add a short reason.",
            target.id.as_str()
        ));
    }
}

fn normalized(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn similar(left: &str, right: &str) -> bool {
    let left = normalized(left);
    let right = normalized(right);
    if left.is_empty() || right.is_empty() {
        return false;
    }
    if left == right {
        return true;
    }
    // Only one added word in a substantial title: no fuzzy semantic guesses.
    let (shorter, longer) = if left.len() < right.len() {
        (&left, &right)
    } else {
        (&right, &left)
    };
    shorter.len() >= 4
        && longer.len() == shorter.len() + 1
        && longer.iter().enumerate().any(|(index, word)| {
            !matches!(word.as_str(), "not" | "no" | "never" | "without")
                && longer
                    .iter()
                    .enumerate()
                    .filter(|(at, _)| *at != index)
                    .map(|(_, word)| word)
                    .eq(shorter.iter())
        })
}

/// Reference wording disambiguates item numbers from ordinary quantities.
/// Versions, times, decimals and linked labels are deliberately left alone.
fn bare_numbers(text: &str) -> Vec<&str> {
    let mut linked = vec![];
    let mut offset = 0;
    while let Some(open) = text[offset..].find('[') {
        let start = offset + open;
        let Some(close) = text[start..].find(']') else {
            break;
        };
        let close = start + close;
        if text[close..].starts_with("](item:") {
            if let Some(end) = text[close..].find(')') {
                linked.push(start..close + end + 1);
            }
        }
        offset = close + 1;
    }
    let bytes = text.as_bytes();
    let mut numbers = vec![];
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len()
            && (bytes[index].is_ascii_digit()
                || (bytes[index] == b'.' && bytes.get(index + 1).is_some_and(u8::is_ascii_digit)))
        {
            index += 1;
        }
        let number = &text[start..index];
        if linked.iter().any(|range| range.contains(&start)) {
            continue;
        }
        let previous = text[..start].chars().next_back();
        let next = text[index..].chars().next();
        if previous.is_some_and(|c| c.is_alphanumeric() || ".:/-+$".contains(c))
            || next.is_some_and(|c| c.is_alphanumeric() || ":/%".contains(c))
        {
            continue;
        }
        let before = text[..start]
            .split_whitespace()
            .next_back()
            .unwrap_or("")
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        let after = text[index..]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        if matches!(
            before.as_str(),
            "score"
                | "measured"
                | "measure"
                | "measurement"
                | "sdk"
                | "version"
                | "release"
                | "v"
                | "at"
                | "about"
                | "cost"
                | "price"
                | "latency"
                | "ratio"
                | "value"
                | "rate"
        ) || matches!(
            after.as_str(),
            "seconds"
                | "second"
                | "s"
                | "ms"
                | "minutes"
                | "hours"
                | "days"
                | "percent"
                | "gb"
                | "mb"
                | "kb"
                | "kg"
                | "dollars"
                | "usd"
                | "inr"
        ) {
            continue;
        }
        let numeric_context = text[..start]
            .split_whitespace()
            .rev()
            .take(4)
            .map(|word| {
                word.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase()
            })
            .any(|word| {
                matches!(
                    word.as_str(),
                    "version"
                        | "sdk"
                        | "score"
                        | "measured"
                        | "measurement"
                        | "decimal"
                        | "ratio"
                        | "value"
                        | "rate"
                        | "price"
                        | "cost"
                        | "latency"
                )
            });
        if numeric_context {
            continue;
        }
        let context = text[..start]
            .split_whitespace()
            .rev()
            .take(4)
            .chain(text[index..].split_whitespace().take(3));
        if context
            .map(|word| {
                word.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase()
            })
            .any(|word| {
                matches!(
                    word.as_str(),
                    "item"
                        | "items"
                        | "see"
                        | "update"
                        | "updated"
                        | "updates"
                        | "change"
                        | "changed"
                        | "changes"
                        | "affects"
                        | "affected"
                        | "dependency"
                        | "dependencies"
                        | "depends"
                        | "replace"
                        | "replaced"
                        | "blocked"
                        | "blocking"
                        | "review"
                )
            })
        {
            numbers.push(number);
        }
    }
    numbers
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn seed() -> Session {
        serde_json::from_str(include_str!(
            "../../../../fixtures/domain/history/seed.json"
        ))
        .unwrap()
    }
    fn request(value: Value) -> ApplyRequest {
        super::super::lenient::expand(
            &serde_json::to_vec(&value).unwrap(),
            &seed().active_binding_id.unwrap(),
        )
        .unwrap()
        .request
    }
    fn receipt() -> SavedReceipt {
        let session = seed();
        SavedReceipt {
            operation_id: session.id.clone(),
            session_id: session.id,
            revision: session.revision,
            data: SavedReceiptData::Apply {
                agent_removals: vec![],
                allocated_refs: UniqueMap(std::collections::BTreeMap::new()),
                messages: vec![],
                item_revisions: UniqueMap(std::collections::BTreeMap::new()),
                topic_revisions: UniqueMap(std::collections::BTreeMap::new()),
                input_result_state: None,
                queue_join_state: None,
                pruned_related: None,
            },
        }
    }
    fn advice(session: &Session, value: Value) -> Vec<String> {
        collect(session, session, &request(value), &receipt())
    }
    fn add(question: &str) -> Value {
        json!({"operations":[{"op":"item.add","topic":{"id":seed().topics.0.keys().next().unwrap()},"type":"task","question":question}]})
    }
    fn contains(warnings: &[String], text: &str) -> bool {
        warnings.iter().any(|warning| warning.contains(text))
    }

    #[test]
    fn duplicate_titles_and_short_labels_are_conservative_and_name_the_existing_item() {
        let mut session = seed();
        let item = session
            .items
            .0
            .get_mut(&ItemRef::new("1").unwrap())
            .unwrap();
        item.short = Some("Release choice".into());
        item.question = "Choose the safe release approach".into();
        assert!(contains(
            &advice(&session, add("Choose the safe release approach!")),
            "Release choice (1)"
        ));
        assert!(contains(
            &advice(&session, add("Choose the safe release approach today")),
            "item.replace"
        ));
        let mut short = add("Different question");
        short["operations"][0]["short"] = json!("release CHOICE");
        assert!(contains(&advice(&session, short), "Possible duplicate"));
        assert!(!contains(
            &advice(
                &session,
                add("Choose the safe release approach without tests")
            ),
            "Possible duplicate"
        ));
        assert!(!contains(
            &advice(&session, add("Choose not the safe release approach")),
            "Possible duplicate"
        ));
        assert!(!contains(
            &advice(&session, add("Unrelated work")),
            "Possible duplicate"
        ));
        session.topics.0.values_mut().next().unwrap().archived_at =
            Some(session.updated_at.clone());
        assert!(!contains(
            &advice(&session, add("Choose the safe release approach")),
            "Possible duplicate"
        ));
        session.topics.0.values_mut().next().unwrap().archived_at = None;
        session.items.0.values_mut().next().unwrap().removed_at = Some(session.updated_at.clone());
        assert!(!contains(
            &advice(&session, add("Choose the safe release approach")),
            "Possible duplicate"
        ));
    }

    #[test]
    fn replay_never_compares_an_addition_to_itself() {
        let session = seed();
        let mut receipt = receipt();
        if let SavedReceiptData::Apply { allocated_refs, .. } = &mut receipt.data {
            allocated_refs.0.insert(
                RequestRef::new("new").unwrap(),
                AllocatedRef::Item {
                    id: ItemRef::new("1").unwrap(),
                },
            );
        }
        let warnings = collect(
            &session,
            &session,
            &request(add("Which release approach?")),
            &receipt,
        );
        assert!(!contains(&warnings, "Possible duplicate"));
    }

    #[test]
    fn bare_references_require_existing_items_and_ignore_named_links() {
        let mut session = seed();
        let mut child = session.items.0.values().next().unwrap().clone();
        child.id = ItemRef::new("1.2").unwrap();
        child.short = Some("Release choice".into());
        session.items.0.insert(child.id.clone(), child);
        let warnings = advice(
            &session,
            json!({"summary":"1.2 needs work; see item 1. Missing 9.9 is unrelated.","operations":[]}),
        );
        assert!(contains(&warnings, "[Release choice](item:1.2)"));
        assert!(contains(&warnings, "Bare item number 1."));
        assert!(!contains(&warnings, "Bare item number 9.9"));
        assert!(!contains(
            &advice(
                &session,
                json!({"summary":"[Release choice 1.2](item:1.2)","operations":[]})
            ),
            "Bare item number"
        ));
        session
            .items
            .0
            .get_mut(&ItemRef::new("1.2").unwrap())
            .unwrap()
            .removed_at = Some(session.updated_at.clone());
        assert!(!contains(
            &advice(&session, json!({"summary":"See 1.2","operations":[]})),
            "Bare item number"
        ));
    }

    #[test]
    fn numbers_do_not_guess_versions_times_decimals_and_quantities() {
        for text in [
            "v1.2",
            "version 1.2",
            "release 1.2",
            "2026-10-13",
            "at 1.2",
            "1:20",
            "1.2ms",
            "1.2 ms",
            "1.2 seconds",
            "$1.2",
            "1.2%",
            "value 1.2",
            "The score is 1.2.",
            "We measured 1.2.",
            "SDK 1.2",
            "Update version to 1.2",
            "Update the SDK to 1.2",
            "We updated the score to 1.2",
            "ratio 1.2",
            "1 task",
            "1.2.3",
            "https://site/1.2",
            "file1.2",
            "-1.2",
            "1.2/3",
        ] {
            assert!(
                bare_numbers(text)
                    .iter()
                    .all(|number| *number != "1" && *number != "1.2"),
                "{text}"
            );
        }
        assert_eq!(bare_numbers("1.2 and 3.4 updated."), ["1.2", "3.4"]);
        assert_eq!(bare_numbers("Item 1 needs work."), ["1"]);
    }

    #[test]
    fn every_required_prose_field_is_checked() {
        let session = seed();
        let cases = [
            json!({"operations":[{"op":"item.add","topic":{"id":session.topics.0.keys().next().unwrap()},"type":"task","question":"item 1"}]}),
            json!({"operations":[{"op":"item.edit","item":{"id":"1"},"patch":{"question":"item 1","note":"item 1"}}]}),
            json!({"operations":[{"op":"item.ask","item":{"id":"1"},"ask":"item 1"}]}),
            json!({"operations":[{"op":"item.status","item":{"id":"1"},"status":"open","outcome":"item 1","why":"item 1"}]}),
            json!({"operations":[{"op":"item.replace","item":{"id":"1"},"replacement":{"id":"2"},"outcome":"item 1","why":"item 1"}]}),
            json!({"operations":[{"op":"reply","item":{"id":"1"},"text":"item 1"}]}),
            json!({"operations":[{"op":"topic.add","name":"New","brief":"item 1"}]}),
            json!({"operations":[{"op":"topic.edit","topic":{"id":session.topics.0.keys().next().unwrap()},"brief":"item 1"}]}),
            json!({"operations":[],"input_result":{"outcome":"answered","explanation":"item 1","handled_through_message_number":1}}),
        ];
        for case in cases {
            assert!(
                contains(&advice(&session, case.clone()), "Bare item number 1."),
                "{case}"
            );
        }
        for field in ["note", "ask", "outcome", "why"] {
            let mut case = add("Distinct task");
            case["operations"][0][field] = json!("See item 1");
            assert!(
                contains(&advice(&session, case), "Bare item number 1."),
                "{field}"
            );
        }
        for field in ["question", "note"] {
            let case = json!({"operations":[{"op":"item.edit","item":{"id":"1"},"patch":{field:"See item 1"}}]});
            assert!(
                contains(&advice(&session, case), "Bare item number 1."),
                "{field}"
            );
        }
    }

    #[test]
    fn existing_owner_input_changes_need_reasons_except_wording_edits() {
        let session = seed();
        let mut edit = json!({"source_input_id":session.id,"attempt_id":session.id,"operations":[{"op":"item.edit","item":{"id":"1"},"patch":{"question":"New wording"}}]});
        assert!(contains(
            &advice(&session, edit.clone()),
            "without a reason"
        ));
        edit["operations"][0]["reason"] = json!("Owner changed direction");
        assert!(!contains(
            &advice(&session, edit.clone()),
            "without a reason"
        ));
        edit["operations"][0]
            .as_object_mut()
            .unwrap()
            .remove("reason");
        edit["operations"][0]["wording_only"] = json!(true);
        assert!(!contains(
            &advice(&session, edit.clone()),
            "without a reason"
        ));
        edit["operations"][0]["wording_only"] = json!(false);
        edit["source_input_id"] = Value::Null;
        assert!(!contains(&advice(&session, edit), "without a reason"));
        for reason in [
            json!({}),
            json!({"why":"Owner approved"}),
            json!({"reason":"Owner approved"}),
        ] {
            let mut operation =
                json!({"op":"item.status","item":{"id":"1"},"status":"in_progress"});
            operation
                .as_object_mut()
                .unwrap()
                .extend(reason.as_object().unwrap().clone());
            let warning = advice(
                &session,
                json!({"source_input_id":session.id,"attempt_id":session.id,"operations":[operation]}),
            );
            assert_eq!(
                contains(&warning, "without a reason"),
                reason.get("reason").is_none()
            );
        }
        let local = json!({"source_input_id":session.id,"attempt_id":session.id,"operations":[{"op":"item.edit","item":{"ref":"new"},"patch":{"question":"New wording"}}]});
        assert!(!contains(&advice(&session, local), "without a reason"));
        let mut same_batch = receipt();
        if let SavedReceiptData::Apply { allocated_refs, .. } = &mut same_batch.data {
            allocated_refs.0.insert(
                RequestRef::new("new").unwrap(),
                AllocatedRef::Item {
                    id: ItemRef::new("1").unwrap(),
                },
            );
        }
        let edit = request(
            json!({"source_input_id":session.id,"attempt_id":session.id,"operations":[{"op":"item.edit","item":{"id":"1"},"patch":{"question":"Creation wording"}}]}),
        );
        assert!(!contains(
            &collect(&session, &session, &edit, &same_batch),
            "without a reason"
        ));
    }

    #[test]
    fn post_request_waiting_count_excludes_archived_removed_answered_and_closed() {
        let before = seed();
        let mut after = before.clone();
        for number in 3..7 {
            let mut item = before.items.0.values().next().unwrap().clone();
            item.id = ItemRef::new(number.to_string()).unwrap();
            item.status = ItemStatus::WaitingOnMe;
            after.items.0.insert(item.id.clone(), item);
        }
        let request = request(json!({"operations":[]}));
        assert!(contains(
            &collect(&before, &after, &request, &receipt()),
            "4 items are waiting"
        ));
        after
            .items
            .0
            .get_mut(&ItemRef::new("3").unwrap())
            .unwrap()
            .removed_at = Some(after.updated_at.clone());
        assert!(!contains(
            &collect(&before, &after, &request, &receipt()),
            "items are waiting"
        ));
        after
            .items
            .0
            .get_mut(&ItemRef::new("3").unwrap())
            .unwrap()
            .removed_at = None;
        let item = &after.items.0[&ItemRef::new("3").unwrap()];
        after.answers.push(Answer {
            id: after.id.clone(),
            seq: PositiveSafeInteger::new(1).unwrap(),
            item_id: item.id.clone(),
            question_revision: item.question_revision,
            question_snapshot: item.question.clone(),
            ask_snapshot: item.ask.clone(),
            options_snapshot: item.options.clone(),
            selected_option_id: None,
            text: "Proceed".into(),
            message_id: after.messages[0].id.clone(),
            input_id: after.id.clone(),
            supersedes_answer_id: None,
            created_at: after.updated_at.clone(),
        });
        assert!(!contains(
            &collect(&before, &after, &request, &receipt()),
            "items are waiting"
        ));
        after.answers.clear();
        after.topics.0.values_mut().next().unwrap().archived_at = Some(after.updated_at.clone());
        assert!(!contains(
            &collect(&before, &after, &request, &receipt()),
            "items are waiting"
        ));
        after.topics.0.values_mut().next().unwrap().archived_at = None;
        after.state = SessionState::Closed;
        assert!(!contains(
            &collect(&before, &after, &request, &receipt()),
            "items are waiting"
        ));
    }

    #[test]
    fn populated_topics_need_a_brief_after_the_request() {
        let before = seed();
        assert!(!contains(
            &advice(&before, json!({"operations":[]})),
            "no brief"
        ));
        let mut after = before.clone();
        let mut item = before.items.0.values().next().unwrap().clone();
        item.id = ItemRef::new("3").unwrap();
        after.items.0.insert(item.id.clone(), item);
        let request = request(json!({"operations":[]}));
        assert!(contains(
            &collect(&before, &after, &request, &receipt()),
            "topic.edit"
        ));
        after.topics.0.values_mut().next().unwrap().brief = Some("Context for the owner".into());
        assert!(!contains(
            &collect(&before, &after, &request, &receipt()),
            "no brief"
        ));
        after.topics.0.values_mut().next().unwrap().brief = None;
        after
            .items
            .0
            .get_mut(&ItemRef::new("3").unwrap())
            .unwrap()
            .removed_at = Some(after.updated_at.clone());
        assert!(!contains(
            &collect(&before, &after, &request, &receipt()),
            "no brief"
        ));
    }
}
