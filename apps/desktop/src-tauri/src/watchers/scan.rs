use super::Emit;
use ariadne_core::{SessionChangedHint, SessionRef};
use ariadne_domain::models::{PositiveSafeInteger, Session};
use ariadne_store::registry::RegisteredProject;
use ariadne_store::session::Store;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Scan {
    revisions: BTreeMap<(String, String), PositiveSafeInteger>,
}
impl Scan {
    pub(super) fn reconcile(
        &mut self,
        projects: &[RegisteredProject],
        selected: Option<&SessionRef>,
        emit: &Emit,
    ) {
        self.revisions.retain(|(project, _), _| {
            projects
                .iter()
                .any(|registered| registered.project_id.as_str() == project)
        });
        if let Some(route) = selected {
            if let Some(project) = projects.iter().find(|p| p.project_id == route.project_id) {
                if let Ok(session) =
                    Store::read_registered(&project.root, &project.project_id, &route.session_id)
                {
                    self.observe(&session, emit);
                }
            }
        }
        for registered in projects {
            let Ok(project) = Store::inspect_registered(&registered.root, &registered.project_id)
            else {
                continue;
            };
            let Ok(sessions) = project.sessions else {
                continue;
            };
            for outcome in sessions {
                if let Ok(session) = outcome.result {
                    self.observe(&session, emit);
                }
            }
        }
    }
    fn observe(&mut self, session: &Session, emit: &Emit) {
        let key = (
            session.project_id.as_str().into(),
            session.id.as_str().into(),
        );
        if self
            .revisions
            .get(&key)
            .is_some_and(|old| *old >= session.revision)
        {
            return;
        }
        if emit(SessionChangedHint {
            session_id: session.id.clone(),
            revision: session.revision,
        }) {
            self.revisions.insert(key, session.revision);
        }
    }
}
