#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MenuRow {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct MenuSnapshot {
    pub title: String,
    pub rows: Vec<MenuRow>,
    pub diagnostics: Vec<String>,
    pub pinned: bool,
}

#[derive(Default)]
pub(super) struct Publication {
    last: Option<MenuSnapshot>,
}

impl Publication {
    pub fn publish<E>(
        &mut self,
        next: MenuSnapshot,
        stopped: bool,
        apply: impl FnOnce(&MenuSnapshot) -> Result<(), E>,
    ) -> Result<bool, E> {
        if stopped || self.last.as_ref() == Some(&next) {
            return Ok(false);
        }
        // Title and menu are separate native writes. A partial failure must not
        // let an older remembered state suppress the next attempt to restore it.
        self.last = None;
        apply(&next)?;
        self.last = Some(next);
        Ok(true)
    }
}

pub(super) fn label(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> MenuSnapshot {
        MenuSnapshot {
            title: "2".into(),
            rows: vec![MenuRow {
                id: "ariadne:route:project/session/item".into(),
                label: "Project · Session · #1".into(),
            }],
            diagnostics: vec!["Host unavailable".into()],
            pinned: false,
        }
    }

    #[test]
    fn identical_captures_publish_once_and_a_fresh_lifecycle_publishes_again() {
        let mut publication = Publication::default();
        let mut writes = 0;
        for _ in 0..3 {
            publication
                .publish(snapshot(), false, |_| {
                    writes += 1;
                    Ok::<_, ()>(())
                })
                .unwrap();
        }
        assert_eq!(
            writes, 1,
            "An unchanged capture must not replace the open native menu"
        );
        assert!(Publication::default()
            .publish(snapshot(), false, |_| Ok::<_, ()>(()))
            .unwrap());
    }

    #[test]
    fn every_native_visible_change_publishes_and_returning_to_old_state_publishes() {
        let initial = snapshot();
        let mut changes = vec![];
        let mut next = initial.clone();
        next.title = "2*".into();
        changes.push(next);
        let mut next = initial.clone();
        next.pinned = true;
        changes.push(next);
        let mut next = initial.clone();
        next.rows[0].id.push_str("-new-session");
        changes.push(next);
        let mut next = initial.clone();
        next.rows[0].label = "Renamed project · Renamed session · #1".into();
        changes.push(next);
        let mut next = initial.clone();
        next.rows.push(MenuRow {
            id: "second".into(),
            label: "Second row".into(),
        });
        changes.push(next);
        let mut next = changes.last().unwrap().clone();
        next.rows.reverse();
        changes.push(next);
        let mut next = initial.clone();
        next.rows.clear();
        next.title.clear();
        changes.push(next);
        let mut next = initial.clone();
        next.diagnostics.push("Waiting snapshot partial".into());
        changes.push(next);
        let mut next = initial.clone();
        next.diagnostics.clear();
        changes.push(next);
        let mut publication = Publication::default();
        publication
            .publish(initial.clone(), false, |_| Ok::<_, ()>(()))
            .unwrap();
        for changed in changes {
            assert!(publication
                .publish(changed.clone(), false, |_| Ok::<_, ()>(()))
                .unwrap());
            assert!(!publication
                .publish::<()>(changed, false, |_| panic!("Identical publication"))
                .unwrap());
            assert!(publication
                .publish(initial.clone(), false, |_| Ok::<_, ()>(()))
                .unwrap());
        }
    }

    #[test]
    fn failed_partial_publication_invalidates_old_state_and_allows_retry() {
        let mut publication = Publication::default();
        let old = snapshot();
        publication
            .publish(old.clone(), false, |_| Ok::<_, &str>(()))
            .unwrap();
        let mut next = old.clone();
        next.pinned = true;
        assert_eq!(
            publication.publish(next.clone(), false, |_| Err(
                "menu write failed after title"
            )),
            Err("menu write failed after title")
        );
        assert!(
            publication
                .publish(old, false, |_| Ok::<_, &str>(()))
                .unwrap(),
            "Restore after partial failure cannot use the previous cache"
        );
        assert_eq!(
            publication.publish(next.clone(), false, |_| Err("retryable failure")),
            Err("retryable failure")
        );
        assert!(publication
            .publish(next, false, |_| Ok::<_, &str>(()))
            .unwrap());
    }

    #[test]
    fn stop_discards_queued_publication_without_marking_it_applied() {
        let mut publication = Publication::default();
        assert!(!publication
            .publish::<()>(snapshot(), true, |_| panic!("Publication after disposal"))
            .unwrap());
        assert!(publication
            .publish(snapshot(), false, |_| Ok::<_, ()>(()))
            .unwrap());
    }

    #[test]
    fn labels_compare_the_actual_bounded_native_text() {
        assert_eq!(label("Project\n\tlabel"), "Projectlabel");
        assert_eq!(label(&"é".repeat(70)).chars().count(), 64);
        assert_eq!(
            label(&format!("{}suffix-one", "x".repeat(64))),
            label(&format!("{}suffix-two", "x".repeat(64)))
        );
    }
}
