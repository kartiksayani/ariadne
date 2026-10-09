use super::{core, HistoryActionError, HistoryActionService};
use crate::*;
use ariadne_domain::models::*;
use ariadne_store::session::Store;
use sha2::{Digest, Sha256 as Hasher};

impl HistoryActionService<'_> {
    /// Read-only owner preview; coordination locks are the only allowed writes.
    pub fn preview(
        &self,
        context: &OwnerContext,
        request: &ContinuePreviewRequest,
    ) -> Result<ContinuePreview, HistoryActionError> {
        owner_target(context, &request.target)?;
        let source = self.snapshot(&request.source)?;
        let topic = source
            .topics
            .0
            .get(&request.source_topic_id)
            .ok_or_else(|| core(CoreErrorCode::NotFound, "The source topic does not exist"))?;
        let target = self.snapshot(&request.target)?;
        let mapping = actions(&source, &request.source_topic_id);
        let readiness = if request.source == request.target {
            ContinueReadiness::Blocked {
                reasons: vec![ContinueBlockReason::SameSession],
            }
        } else if target.state != SessionState::Active {
            ContinueReadiness::Blocked {
                reasons: vec![ContinueBlockReason::TargetClosed],
            }
        } else if let Some(binding) = selected(&target) {
            if binding.pause_reason == Some(PauseReason::Incompatible) {
                ContinueReadiness::Blocked {
                    reasons: vec![ContinueBlockReason::BindingInvalid],
                }
            } else {
                ContinueReadiness::Ready {
                    binding_id: binding.id.clone(),
                    generation: binding.generation.clone(),
                    host_available: binding.connection_state == ConnectionState::Connected,
                }
            }
        } else {
            ContinueReadiness::Blocked {
                reasons: vec![ContinueBlockReason::BindingUnknown],
            }
        };
        let external = mapping
            .iter()
            .filter(|m| matches!(m.action, ContinueCopyAction::ImportedDrop { .. }))
            .count();
        let summary = format!("Continue topic {} from project {} / session {} at revision {}. Copy {} items, {} messages, {} rounds and {} answers with full saved bodies and source provenance. Agent ownership and live recipient routing move to the explicitly selected target binding; Me and Other owners otherwise remain unchanged. Finished states and replacement links within the copied topic remain unchanged. {} external replacements become imported Dropped items; original links remain source history. Unanswered copied asks become Waiting on me with an answerable question round. Read the copied topic and its complete history before proceeding; reuse existing copied items rather than recreating them.", topic.id.as_str(), source.project_id.as_str(), source.id.as_str(), source.revision.value(), mapping.len(), messages(&source, &request.source_topic_id).len(), source.rounds.0.values().filter(|r| source.items.0.get(&r.item_id).is_some_and(|i| i.topic_id == topic.id)).count(), source.answers.iter().filter(|a| source.items.0.get(&a.item_id).is_some_and(|i| i.topic_id == topic.id)).count(), external);
        let preview = ContinuePreview {
            source: request.source.clone(),
            source_topic_id: topic.id.clone(),
            source_revision: source.revision,
            source_sha256: hash(&source, &topic.id)?,
            target: request.target.clone(),
            summary,
            mapping,
            readiness,
        };
        QueryResult::TopicContinuePreview(preview.clone()).validate_for(
            &QueryContext::owner(context.clone()),
            &QueryRequest::TopicContinuePreview(request.clone()),
        )?;
        Ok(preview)
    }

    pub(super) fn snapshot(&self, route: &SessionRef) -> Result<Session, HistoryActionError> {
        let project = self.registry.resolve_project(&route.project_id)?;
        Ok(Store::read_registered(
            &self.registry.project_dir(&project.project_id),
            &project.project_id,
            &route.session_id,
        )?)
    }
}
pub(super) fn owner_target(context: &OwnerContext, target: &SessionRef) -> Result<(), CoreError> {
    if matches!(context.scope(), OwnerScope::Session(route) if route.project_id() == &target.project_id && route.session_id() == &target.session_id)
    {
        Ok(())
    } else {
        Err(core(
            CoreErrorCode::PermissionDenied,
            "Continue requires an owner route to the explicit target session",
        ))
    }
}
pub(super) fn hash(source: &Session, topic: &UuidV4) -> Result<Sha256, CoreError> {
    let bytes = serde_json::to_vec(&(source, topic)).map_err(|_| {
        core(
            CoreErrorCode::InvalidArgument,
            "Cannot serialize the validated source snapshot",
        )
    })?;
    Ok(Sha256::new(format!("{:x}", Hasher::digest(bytes))).expect("canonical SHA-256"))
}
pub(super) fn selected(session: &Session) -> Option<&Binding> {
    session
        .active_binding_id
        .as_ref()
        .and_then(|id| session.bindings.0.get(id))
}
pub(super) fn actions(source: &Session, topic: &UuidV4) -> Vec<ContinueItemPreview> {
    source.items.0.values().filter(|i| &i.topic_id == topic).map(|item| {
        let action = match &item.replaced_by {
            Some(id) if !source.items.0.get(id).is_some_and(|replacement| &replacement.topic_id == topic) => ContinueCopyAction::ImportedDrop {
                external_replacement_id: id.clone(),
                outcome: format!("Imported replacement outside the continued topic: {}", id.as_str()),
                why: "The original source replacement remains provenance; it is not a live target edge.".into(),
            },
            _ => ContinueCopyAction::Copy {},
        };
        ContinueItemPreview { source_item_id: item.id.clone(), action }
    }).collect()
}
pub(super) fn messages<'a>(source: &'a Session, topic: &UuidV4) -> Vec<&'a Message> {
    use std::collections::BTreeSet;
    let items: BTreeSet<_> = source
        .items
        .0
        .values()
        .filter(|i| &i.topic_id == topic)
        .map(|i| &i.id)
        .collect();
    let required: BTreeSet<_> = source
        .items
        .0
        .values()
        .filter(|i| &i.topic_id == topic)
        .flat_map(|i| {
            std::iter::once(&i.created_message_id)
                .chain(i.updated_message_ids.iter())
                .chain(i.status_history.iter().map(|h| &h.cause_message_id))
        })
        .chain(
            source
                .rounds
                .0
                .values()
                .filter(|r| items.contains(&r.item_id))
                .flat_map(|r| {
                    std::iter::once(&r.opened_message_id)
                        .chain(r.owner_message_ids.iter())
                        .chain(r.agent_message_ids.iter())
                }),
        )
        .chain(
            source
                .answers
                .iter()
                .filter(|a| items.contains(&a.item_id))
                .map(|a| &a.message_id),
        )
        .collect();
    source
        .messages
        .iter()
        .filter(|m| {
            m.topic_id.as_ref() == Some(topic)
                || m.item_id.as_ref().is_some_and(|id| items.contains(id))
                || m.items_touched.iter().any(|id| items.contains(id))
                || required.contains(&m.id)
        })
        .collect()
}
