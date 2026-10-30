//! Filing advice is derived locally; it is never part of a saved receipt.
use ariadne_core::{ApplyRequest, EntityRef, Operation, UuidRef};
use ariadne_domain::{models::*, visibility::item_is_removed};
use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum ProseKind {
    Markdown,
    Plain,
}

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
    let mut populated_topics = BTreeSet::new();
    let mut prose = vec![request.summary.as_str()];
    let mut plain_prose = vec![];
    if let Some(result) = &request.input_result {
        prose.push(&result.explanation);
    }
    for operation in &request.operations {
        match operation {
            Operation::ItemAdd(add) => {
                if let Some(topic) = resolve_topic(&add.topic, receipt) {
                    populated_topics.insert(topic);
                }
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
                if multiline(&add.question) {
                    let target = EntityRef::Local(ariadne_core::LocalRef {
                        r#ref: add.r#ref.clone(),
                    });
                    multiline_warning(after, receipt, &target, &mut warnings);
                }
                prose.push(&add.question);
                prose.extend(add.note.as_deref());
                prose.extend(add.ask.as_deref());
                prose.extend(add.outcome.as_deref());
                prose.extend(add.why.as_deref());
                for option in add.options.iter().flatten() {
                    plain_prose.push(option.label.as_str());
                    plain_prose.push(option.consequence.as_str());
                }
            }
            Operation::ItemEdit {
                item,
                patch,
                reason,
                wording_only,
            } => {
                if patch.question.as_deref().is_some_and(multiline) {
                    multiline_warning(after, receipt, item, &mut warnings);
                }
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
            Operation::ItemAsk { ask, options, .. } => {
                prose.push(ask);
                for option in options {
                    plain_prose.push(option.label.as_str());
                    plain_prose.push(option.consequence.as_str());
                }
            }
            Operation::ItemReplace { outcome, why, .. } => {
                prose.push(outcome);
                prose.push(why);
            }
            Operation::Reply { text, .. } => prose.push(text),
            Operation::TopicAdd {
                r#ref, name, brief, ..
            } => {
                if let Some(topic) = resolve_topic(
                    &UuidRef::Local(ariadne_core::LocalRef {
                        r#ref: r#ref.clone(),
                    }),
                    receipt,
                ) {
                    populated_topics.insert(topic);
                }
                plain_prose.push(name.as_str());
                prose.extend(brief.as_deref());
            }
            Operation::TopicEdit { name, brief, .. } => {
                plain_prose.extend(name.as_deref());
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
    for (text, kind) in prose
        .into_iter()
        .map(|text| (text, ProseKind::Markdown))
        .chain(plain_prose.into_iter().map(|text| (text, ProseKind::Plain)))
    {
        for number in bare_numbers(text) {
            if let Some(item) = live.iter().find(|item| item.id.as_str() == number) {
                if mentioned.insert((item.id.clone(), kind)) {
                    warnings.push(match kind {
                        ProseKind::Markdown => format!(
                            "Bare item number {}. Use a named link: [{}](item:{}).",
                            item.id.as_str(),
                            label(item),
                            item.id.as_str()
                        ),
                        ProseKind::Plain => format!(
                            "Bare item number {}. Name the item instead of its number.",
                            item.id.as_str()
                        ),
                    });
                }
            }
        }
    }
    if after.state == SessionState::Active {
        let waiting = live
            .iter()
            .filter(|item| ariadne_core::queries::waiting_unanswered(after, item))
            .count();
        let previously_waiting = before
            .items
            .0
            .values()
            .filter(|item| {
                visible(before, item) && ariadne_core::queries::waiting_unanswered(before, item)
            })
            .count();
        if waiting > 3 && waiting > previously_waiting {
            warnings.push(format!(
                "{waiting} items are waiting on the owner. Finish or withdraw old questions."
            ));
        }
    }
    for topic in after.topics.0.values().filter(|topic| {
        populated_topics.contains(&topic.id)
            && topic.removed_at.is_none()
            && topic.archived_at.is_none()
    }) {
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

fn resolve_topic(target: &UuidRef, receipt: &SavedReceipt) -> Option<UuidV4> {
    match target {
        UuidRef::Existing(target) => Some(target.id.clone()),
        UuidRef::Local(target) => match &receipt.data {
            SavedReceiptData::Apply { allocated_refs, .. } => {
                match allocated_refs.0.get(&target.r#ref) {
                    Some(AllocatedRef::Topic { id }) => Some(id.clone()),
                    _ => None,
                }
            }
            _ => None,
        },
    }
}

/// A trailing line break is trimmed away; one inside the text is not.
fn multiline(question: &str) -> bool {
    question.trim().contains(['\n', '\r'])
}

/// Names the item the way the duplicate warning does; a new item's id comes
/// from the receipt, which preview fills too.
fn multiline_warning(
    after: &Session,
    receipt: &SavedReceipt,
    target: &EntityRef,
    warnings: &mut Vec<String>,
) {
    let id = match target {
        EntityRef::Existing(target) => Some(&target.id),
        EntityRef::Local(target) => match &receipt.data {
            SavedReceiptData::Apply { allocated_refs, .. } => {
                match allocated_refs.0.get(&target.r#ref) {
                    Some(AllocatedRef::Item { id }) => Some(id),
                    _ => None,
                }
            }
            _ => None,
        },
    };
    if let Some(item) = id.and_then(|id| after.items.0.get(id)) {
        warnings.push(format!(
            "Item {} ({}): `question` is the title and shows on one line. Put the description in `note`.",
            label(item),
            item.id.as_str()
        ));
    }
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

/// Dotted references need only match a visible item. Root numbers need an
/// explicit item/items prefix, including the rest of a directly introduced list.
fn bare_numbers(text: &str) -> Vec<&str> {
    let ignored = markdown_ranges(text);
    let bytes = text.as_bytes();
    let mut numbers = vec![];
    let mut index = 0;
    let mut list_end = None;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() || ignored[index] {
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
        let prefix = text[..start].trim_end();
        let before = prefix
            .rsplit(|c: char| !c.is_alphabetic())
            .next()
            .unwrap_or("")
            .to_lowercase();
        let explicit = matches!(before.as_str(), "item" | "items")
            && text[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        let continued = list_end.is_some_and(|end| {
            matches!(
                text[end..start].trim().to_lowercase().as_str(),
                "," | "and" | "or" | ", and" | ", or"
            )
        });
        list_end = None;
        let line_prefix = text[..start].rsplit('\n').next().unwrap_or("");
        if !number.contains('.')
            && line_prefix.trim().is_empty()
            && matches!(bytes.get(index), Some(b'.' | b')'))
            && bytes.get(index + 1).is_some_and(u8::is_ascii_whitespace)
        {
            continue;
        }
        let previous = text[..start].chars().next_back();
        let next = text[index..].chars().next();
        if prefix.ends_with('#')
            || previous.is_some_and(|c| (c.is_alphanumeric() && !explicit) || ".:/-+$#".contains(c))
            || next.is_some_and(|c| c.is_alphanumeric() || ":/%".contains(c))
        {
            continue;
        }
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
        // Keep common numeric prose conservative without requiring a general
        // reference verb: "Fixed 3.2 first" still identifies the visible item.
        if !explicit
            && !continued
            && text[..start]
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
                })
        {
            continue;
        }
        if number.contains('.') || explicit || continued {
            numbers.push(number);
            if explicit || continued {
                list_end = Some(index);
            }
        }
    }
    numbers
}

/// Ignore code and Markdown link text/destinations before looking for numbers.
/// Bracketed labels are conservatively skipped even for reference-style links.
fn markdown_ranges(text: &str) -> Vec<bool> {
    let bytes = text.as_bytes();
    let mut ignored = vec![false; bytes.len()];
    let mut fence = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let mut trimmed = line.trim_start();
        // Fenced code can sit inside one or more Markdown blockquotes.
        let quote_limit = fence.map(|(_, _, depth)| depth).unwrap_or(usize::MAX);
        let mut quote_depth = 0;
        while let Some(quoted) = trimmed.strip_prefix('>') {
            if quote_depth == quote_limit {
                break;
            }
            trimmed = quoted.trim_start();
            quote_depth += 1;
        }
        // A list item's opening fence follows its bullet or ordered marker;
        // continuation and closing lines are already handled by trim_start.
        let list_prefix = if matches!(trimmed.as_bytes().first(), Some(b'-' | b'+' | b'*')) {
            1
        } else {
            let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && matches!(trimmed.as_bytes().get(digits), Some(b'.' | b')')) {
                digits + 1
            } else {
                0
            }
        };
        if fence.is_none()
            && list_prefix > 0
            && trimmed
                .as_bytes()
                .get(list_prefix)
                .is_some_and(u8::is_ascii_whitespace)
        {
            trimmed = trimmed[list_prefix..].trim_start();
        }
        let marker = trimmed.as_bytes().first().copied();
        let run = trimmed
            .bytes()
            .take_while(|byte| Some(*byte) == marker)
            .count();
        let delimiter = marker.filter(|byte| matches!(byte, b'`' | b'~') && run >= 3);
        if let Some((open, length, _)) = fence {
            ignored[offset..offset + line.len()].fill(true);
            if delimiter == Some(open) && run >= length && trimmed[run..].trim().is_empty() {
                fence = None;
            }
        } else if let Some(marker) = delimiter {
            ignored[offset..offset + line.len()].fill(true);
            fence = Some((marker, run, quote_depth));
        }
        offset += line.len();
    }
    let mut index = 0;
    while index < bytes.len() {
        if ignored[index] {
            index += 1;
            continue;
        }
        let start = index;
        if bytes[index..].starts_with(b"https://") || bytes[index..].starts_with(b"http://") {
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            ignored[start..index].fill(true);
        } else if bytes[index] == b'`' {
            let run = bytes[index..]
                .iter()
                .take_while(|byte| **byte == b'`')
                .count();
            index += run;
            let mut end = index;
            while end < bytes.len() {
                if bytes[end] == b'`' {
                    let close = bytes[end..]
                        .iter()
                        .take_while(|byte| **byte == b'`')
                        .count();
                    end += close;
                    if close == run {
                        ignored[start..end].fill(true);
                        index = end;
                        break;
                    }
                } else {
                    end += 1;
                }
            }
        } else if bytes[index] == b'[' {
            if let Some(label_end) = delimited_end(bytes, index, b'[', b']') {
                index = label_end;
                if bytes.get(index) == Some(&b'(') {
                    index = delimited_end(bytes, index, b'(', b')').unwrap_or(bytes.len());
                } else if bytes.get(index) == Some(&b'[') {
                    index = delimited_end(bytes, index, b'[', b']').unwrap_or(bytes.len());
                } else if bytes.get(index) == Some(&b':') {
                    while index < bytes.len() && bytes[index] != b'\n' {
                        index += 1;
                    }
                }
                ignored[start..index].fill(true);
            } else {
                // An unfinished label may be an incomplete link; leave the
                // rest alone rather than repeatedly scanning the same suffix.
                ignored[start..].fill(true);
                index = bytes.len();
            }
        } else if bytes[index] == b'<' {
            if let Some(end) = bytes[index..].iter().position(|byte| *byte == b'>') {
                index += end + 1;
                ignored[start..index].fill(true);
            } else {
                index += 1;
            }
        } else {
            index += 1;
        }
    }
    ignored
}

fn delimited_end(bytes: &[u8], start: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0;
    let mut index = start;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index += 2;
            continue;
        }
        if bytes[index] == open {
            depth += 1;
        } else if bytes[index] == close {
            depth -= 1;
            if depth == 0 {
                return Some(index + 1);
            }
        }
        index += 1;
    }
    None
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
    fn add_fixture_item(session: &mut Session, number: &str, status: ItemStatus) {
        let mut item = session.items.0.values().next().unwrap().clone();
        item.id = ItemRef::new(number).unwrap();
        item.status = status;
        session.items.0.insert(item.id.clone(), item);
    }

    #[test]
    fn bare_reference_scan_distinguishes_existing_references_from_prose_and_markdown() {
        let mut session = seed();
        for number in ["3", "4", "1.2", "3.2", "1.2.3"] {
            add_fixture_item(&mut session, number, ItemStatus::Open);
        }
        for text in [
            "1. Update the docs",
            "items\n1. Update the docs",
            "items\n1) Update the docs",
            "Review PR #3",
            "Review PR # 3.2",
            "Changed 3 files",
            "Updated 2 tests",
            "see [PR 3](https://example.test/review)",
            "see [PR 3.2](https://example.test/review)",
            "see [review](https://example.test/item 3.2)",
            "see [review](https://example.test/(item 3.2))",
            "see [item 3.2][reference]",
            "[reference]: https://example.test/?id=3.2",
            "[reference]: HTTPS://example.test/?id=3.2",
            "[reference]: ftp://example.test/?id=3.2",
            "see <https://example.test/item 3.2>",
            "`item 3 and 3.2`",
            "``item 3 and `3.2` ``",
            "```rust\nitem 3 and 3.2\n```",
            "~~~text\nitem 3 and 3.2\n~~~",
            "> ~~~\n> Fixed 3.2 first\n> ~~~",
            "> ```text\n> Fixed 3.2 first\n> ```",
            "> > ~~~\n> > Fixed 3.2 first\n> > ~~~",
            ">> ```text\n>> Fixed 3.2 first\n>> ```",
            "- ~~~\n  Fixed 3.2 first\n  ~~~",
            "+ ~~~text\n  Fixed 3.2 first\n  ~~~",
            "* ```text\n  Fixed 3.2 first\n  ```",
            "1. ~~~\n   Fixed 3.2 first\n   ~~~",
            "2) ~~~text\n   Fixed 3.2 first\n   ~~~",
            "~~~\n- ~~~\nFixed 3.2 first\n~~~",
            "~~~\n1. ~~~\nFixed 3.2 first\n~~~",
            "~~~\n> ~~~\nFixed 3.2 first\n~~~",
            "> ~~~\n> > ~~~\n> Fixed 3.2 first\n> ~~~",
            "version v1.2",
            "version 1.2.3",
            "Version 1.2.4 is released",
            "xitem3 needs review",
            "someitems4 needs review",
            "item3 needs review",
            "items3 and4 need review",
        ] {
            let warnings = advice(&session, json!({"summary":text,"operations":[]}));
            assert!(
                !contains(&warnings, "Bare item number"),
                "{text}: {warnings:?}"
            );
        }
        for (text, numbers) in [
            ("Fixed 3.2 first", vec!["3.2"]),
            ("see item 4", vec!["4"]),
            ("items 3 and 4", vec!["3", "4"]),
            ("items 3, 4 and 1", vec!["3", "4", "1"]),
            ("修正 3.2 完成", vec!["3.2"]),
            ("`ignore item 3` then fixed 3.2 first", vec!["3.2"]),
            ("```\nitem 3\n```\nFixed 3.2 first", vec!["3.2"]),
            (
                "> > ~~~\n> > Fixed 3.2 first\n> > ~~~\nSee item 4",
                vec!["4"],
            ),
            ("- ~~~\n  Fixed 3.2 first\n  ~~~\nSee item 4", vec!["4"]),
            ("1. ~~~\n   Fixed 3.2 first\n   ~~~\nSee item 4", vec!["4"]),
            ("See item 1.2.3", vec!["1.2.3"]),
            ("items 3 changed 4 files", vec!["3"]),
            ("3.2 and 4 files changed", vec!["3.2"]),
            ("items 3 and\n4. Update docs", vec!["3"]),
        ] {
            let warnings = advice(&session, json!({"summary":text,"operations":[]}));
            for number in &numbers {
                assert!(
                    contains(&warnings, &format!("Bare item number {number}.")),
                    "{text}: {warnings:?}"
                );
            }
            assert_eq!(
                warnings
                    .iter()
                    .filter(|warning| warning.starts_with("Bare item number"))
                    .count(),
                numbers.len(),
                "{text}: {warnings:?}"
            );
        }
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
    fn plain_fields_recommend_naming_items_without_markdown_links() {
        let session = seed();
        let topic = session.topics.0.keys().next().unwrap();
        for op in ["topic.add", "topic.edit", "item.add", "item.ask"] {
            let fields: &[&str] = if op.starts_with("topic.") {
                &["name"]
            } else {
                &["label", "consequence"]
            };
            for field in fields {
                let mut operation = match op {
                    "topic.add" => json!({"op":op,"name":"New topic"}),
                    "topic.edit" => json!({"op":op,"topic":{"id":topic}}),
                    "item.add" => {
                        json!({"op":op,"topic":{"id":topic},"type":"decision","question":"Distinct choice","ask":"Choose an approach"})
                    }
                    _ => json!({"op":op,"item":{"id":"1"},"ask":"Choose an approach"}),
                };
                if *field == "name" {
                    operation[field] = json!("See item 1");
                } else {
                    let mut option = json!({"label":"Proceed","consequence":"Work continues"});
                    option[field] = json!("See item 1");
                    operation["options"] = json!([option]);
                }
                assert_eq!(
                    advice(&session, json!({"operations":[operation]})),
                    ["Bare item number 1. Name the item instead of its number."],
                    "{op} {field}"
                );
            }
        }
    }

    #[test]
    fn bare_reference_advice_is_deduplicated_per_item_and_field_kind() {
        let mut session = seed();
        session
            .items
            .0
            .get_mut(&ItemRef::new("1").unwrap())
            .unwrap()
            .short = Some("Release choice".into());
        let topic = session.topics.0.keys().next().unwrap();
        let markdown = json!({"op":"reply","item":{"id":"1"},"text":"See item 1 and item 1"});
        let plain = json!({"op":"topic.edit","topic":{"id":topic},"name":"See item 1 and item 1"});
        for operations in [
            json!([markdown, plain, markdown, plain]),
            json!([plain, markdown, plain, markdown]),
        ] {
            let warnings = advice(&session, json!({"operations":operations}));
            assert_eq!(warnings.len(), 2);
            assert!(warnings.iter().any(|warning| warning
                == "Bare item number 1. Use a named link: [Release choice](item:1)."));
            assert!(warnings.iter().any(
                |warning| warning == "Bare item number 1. Name the item instead of its number."
            ));
        }
    }

    #[test]
    fn every_required_prose_field_is_checked_independently() {
        let session = seed();
        let topic = session.topics.0.keys().next().unwrap();
        let cases = [
            json!({"summary":"item 1","operations":[]}),
            json!({"operations":[],"input_result":{"outcome":"answered","explanation":"item 1","handled_through_message_number":1}}),
            json!({"operations":[{"op":"reply","item":{"id":"1"},"text":"item 1"}]}),
            json!({"operations":[{"op":"item.ask","item":{"id":"1"},"ask":"item 1"}]}),
        ];
        for case in cases {
            assert!(
                contains(&advice(&session, case.clone()), "Bare item number 1."),
                "{case}"
            );
        }
        for field in ["question", "note", "ask", "outcome", "why"] {
            let mut case = add("Distinct task");
            case["operations"][0][field] = json!("See item 1");
            assert!(
                contains(&advice(&session, case), "Bare item number 1."),
                "item.add {field}"
            );
        }
        for field in ["question", "note"] {
            let case = json!({"operations":[{"op":"item.edit","item":{"id":"1"},"patch":{field:"See item 1"}}]});
            assert!(
                contains(&advice(&session, case), "Bare item number 1."),
                "item.edit {field}"
            );
        }
        for op in ["item.status", "item.replace"] {
            for field in ["outcome", "why"] {
                let mut operation = if op == "item.status" {
                    json!({"op":op,"item":{"id":"1"},"status":"open"})
                } else {
                    json!({"op":op,"item":{"id":"1"},"replacement":{"id":"2"},"outcome":"Changed","why":"Approved"})
                };
                operation[field] = json!("See item 1");
                assert!(
                    contains(
                        &advice(&session, json!({"operations":[operation]})),
                        "Bare item number 1."
                    ),
                    "{op} {field}"
                );
            }
        }
        for op in ["topic.add", "topic.edit"] {
            for field in ["name", "brief"] {
                let mut operation = if op == "topic.add" {
                    json!({"op":op,"name":"New topic"})
                } else {
                    json!({"op":op,"topic":{"id":topic}})
                };
                operation[field] = json!("See item 1");
                assert!(
                    contains(
                        &advice(&session, json!({"operations":[operation]})),
                        "Bare item number 1."
                    ),
                    "{op} {field}"
                );
            }
        }
        for op in ["item.add", "item.ask"] {
            for field in ["label", "consequence"] {
                let mut operation = if op == "item.add" {
                    json!({"op":op,"topic":{"id":topic},"type":"decision","question":"Distinct choice","ask":"Choose an approach"})
                } else {
                    json!({"op":op,"item":{"id":"1"},"ask":"Choose an approach"})
                };
                let mut option = json!({"label":"Proceed","consequence":"Work continues"});
                option[field] = json!("See item 1");
                operation["options"] = json!([option]);
                assert!(
                    contains(
                        &advice(&session, json!({"operations":[operation]})),
                        "Bare item number 1."
                    ),
                    "{op} options.{field}"
                );
            }
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
    fn waiting_advice_requires_an_increase_above_three_and_does_not_nag_on_replay() {
        let request =
            request(json!({"operations":[{"op":"item.ask","item":{"id":"1"},"ask":"Proceed?"}]}));
        for (before_count, after_count, expected) in [
            (2, 3, false),
            (3, 4, true),
            (4, 5, true),
            (5, 5, false),
            (5, 4, false),
        ] {
            let mut before = seed();
            for number in 3..3 + before_count {
                add_fixture_item(&mut before, &number.to_string(), ItemStatus::WaitingOnMe);
            }
            let mut after = seed();
            for number in 3..3 + after_count {
                add_fixture_item(&mut after, &number.to_string(), ItemStatus::WaitingOnMe);
            }
            let warnings = collect(&before, &after, &request, &receipt());
            assert_eq!(
                contains(&warnings, "items are waiting"),
                expected,
                "{before_count} -> {after_count}"
            );
            // Previewing the same candidate must produce exactly the same advice.
            assert_eq!(collect(&before, &after, &request, &receipt()), warnings);
            assert!(!contains(
                &collect(&after, &after, &request, &receipt()),
                "items are waiting"
            ));
        }
    }

    #[test]
    fn unrelated_edits_replies_and_replays_do_not_nag_about_existing_topic_or_waiting_work() {
        let mut session = seed();
        for number in 3..8 {
            add_fixture_item(&mut session, &number.to_string(), ItemStatus::WaitingOnMe);
        }
        let topic = session.topics.0.keys().next().unwrap();
        for value in [
            json!({"operations":[]}),
            json!({"operations":[{"op":"item.edit","item":{"id":"1"},"patch":{"note":"Clarified the evidence"}}]}),
            json!({"operations":[{"op":"reply","item":{"id":"1"},"text":"Recorded the update"}]}),
            json!({"operations":[{"op":"topic.edit","topic":{"id":topic},"name":"Release context"}]}),
        ] {
            assert!(advice(&session, value.clone()).is_empty(), "{value}");
        }
    }

    #[test]
    fn topic_brief_advice_resolves_created_and_populated_topics_from_the_receipt() {
        let before = seed();
        let mut after = before.clone();
        let topic_id = UuidV4::new("00000000-0000-4000-8000-000000000099").unwrap();
        let mut topic = before.topics.0.values().next().unwrap().clone();
        topic.id = topic_id.clone();
        topic.name = "New work".into();
        topic.order = PositiveSafeInteger::new(2).unwrap();
        after.topics.0.insert(topic.id.clone(), topic);
        for number in 3..6 {
            add_fixture_item(&mut after, &number.to_string(), ItemStatus::Open);
            after
                .items
                .0
                .get_mut(&ItemRef::new(number.to_string()).unwrap())
                .unwrap()
                .topic_id = topic_id.clone();
        }
        let mut saved = receipt();
        if let SavedReceiptData::Apply { allocated_refs, .. } = &mut saved.data {
            allocated_refs.0.insert(
                RequestRef::new("created_topic").unwrap(),
                AllocatedRef::Topic {
                    id: topic_id.clone(),
                },
            );
        }
        let requests = [
            json!({"operations":[{"op":"topic.add","ref":"created_topic","name":"New work"}]}),
            json!({"operations":[{"op":"item.add","topic":{"ref":"created_topic"},"type":"task","question":"Distinct task"}]}),
            json!({"operations":[{"op":"item.add","topic":{"id":topic_id},"type":"task","question":"Distinct task"}]}),
        ];
        for value in requests {
            let request = request(value.clone());
            let warnings = collect(&before, &after, &request, &saved);
            assert!(
                contains(&warnings, "Topic New work (2)"),
                "{value}: {warnings:?}"
            );
            assert_eq!(collect(&before, &after, &request, &saved), warnings);
            // A replay still scopes topic advice to the original creation/addition.
            assert!(contains(
                &collect(&after, &after, &request, &saved),
                "Topic New work (2)"
            ));
        }
        after.topics.0.get_mut(&topic_id).unwrap().brief = Some("Settled background".into());
        let request = request(
            json!({"operations":[{"op":"topic.add","ref":"created_topic","name":"New work"}]}),
        );
        assert!(!contains(
            &collect(&before, &after, &request, &saved),
            "no brief"
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
        let request = request(add("Distinct third task"));
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

    const ONE_LINE: &str = "shows on one line";

    /// Advice for an apply whose receipt allocates each `(ref, number,
    /// question)` and whose saved session holds those items.
    fn added(value: Value, refs: &[(&str, &str, &str)]) -> Vec<String> {
        let before = seed();
        let mut after = before.clone();
        let mut saved = receipt();
        for (reference, number, question) in refs {
            add_fixture_item(&mut after, number, ItemStatus::Open);
            let item = after
                .items
                .0
                .get_mut(&ItemRef::new(*number).unwrap())
                .unwrap();
            item.short = None;
            item.question = (*question).into();
            if let SavedReceiptData::Apply { allocated_refs, .. } = &mut saved.data {
                allocated_refs.0.insert(
                    RequestRef::new(*reference).unwrap(),
                    AllocatedRef::Item {
                        id: ItemRef::new(*number).unwrap(),
                    },
                );
            }
        }
        collect(&before, &after, &request(value), &saved)
    }

    fn add_ref(question: &str) -> Value {
        let mut value = add(question);
        value["operations"][0]["ref"] = json!("new");
        value
    }

    #[test]
    fn a_multi_line_added_question_warns_once_and_names_the_new_item() {
        for question in [
            "Pick a cache\nThe old one is slow",
            "Pick a cache\r\nThe old one is slow",
            "Pick a cache\rThe old one is slow",
            "Pick a cache\n\nThe old one is slow\nand leaks",
        ] {
            let warnings = added(add_ref(question), &[("new", "3", question)]);
            let found: Vec<_> = warnings
                .iter()
                .filter(|warning| warning.contains(ONE_LINE))
                .collect();
            assert_eq!(found.len(), 1, "{question:?}: {warnings:?}");
            assert!(
                found[0].starts_with("Item Pick a cache The old one is slow")
                    && found[0].contains(
                        "(3): `question` is the title and shows on one line. Put the description in `note`."
                    ),
                "{question:?}: {warnings:?}"
            );
        }
    }

    #[test]
    fn one_line_and_trailing_break_questions_do_not_warn() {
        for question in [
            "Pick a cache",
            "Pick a cache\n",
            "Pick a cache\r\n",
            "\nPick a cache\n\n",
        ] {
            let warnings = added(add_ref(question), &[("new", "3", question)]);
            assert!(!contains(&warnings, ONE_LINE), "{question:?}: {warnings:?}");
        }
    }

    #[test]
    fn a_multi_line_edited_question_warns_and_other_edits_do_not() {
        let session = seed();
        let edit = |patch: Value| {
            advice(
                &session,
                json!({"operations":[{"op":"item.edit","item":{"id":"1"},"patch":patch}]}),
            )
        };
        let warnings = edit(json!({"question":"Pick a cache\nThe old one is slow"}));
        assert_eq!(
            warnings
                .iter()
                .filter(|warning| warning.contains(ONE_LINE))
                .count(),
            1,
            "{warnings:?}"
        );
        let item = &session.items.0[&ItemRef::new("1").unwrap()];
        assert!(
            contains(&warnings, &format!("Item {} (1): ", label(item))),
            "{warnings:?}"
        );
        for patch in [
            json!({"question":"Pick a cache"}),
            json!({"question":"Pick a cache\n"}),
            json!({"note":"Line one\nLine two"}),
        ] {
            assert!(!contains(&edit(patch.clone()), ONE_LINE), "{patch}");
        }
    }

    #[test]
    fn a_multi_line_child_question_warns_for_the_child_only() {
        let child = "Measure the hit rate\nUse last week's traffic";
        let warnings = added(
            json!({"operations":[{"op":"item.add","ref":"parent","topic":{"id":seed().topics.0.keys().next().unwrap()},
                "type":"task","question":"Pick a cache",
                "children":[{"ref":"kid","type":"task","question":child}]}]}),
            &[("parent", "3", "Pick a cache"), ("kid", "3.1", child)],
        );
        let found: Vec<_> = warnings
            .iter()
            .filter(|warning| warning.contains(ONE_LINE))
            .collect();
        assert_eq!(found.len(), 1, "{warnings:?}");
        assert!(found[0].contains("(3.1): "), "{warnings:?}");
    }
}
