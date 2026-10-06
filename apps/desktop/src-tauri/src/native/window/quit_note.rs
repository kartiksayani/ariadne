use ariadne_core::{native::NativeCoreService, *};
use ariadne_domain::models::*;

/// Read after owning shutdown has drained, on its blocking worker. Retain the
/// canonical Core itself: the ordinary runtime bridge correctly rejects new
/// admission after the immediate Quit fence. This path performs no mutations,
/// provider calls or dispatch, and does not reacquire a runtime/binding lease.
pub(crate) fn required(core: &NativeCoreService) -> Result<bool, CoreError> {
    let catalogue = core.registry().catalogue()?;
    let mut unreadable = None;
    for project in catalogue.projects {
        let reads = match project.result.and_then(|project| project.sessions) {
            Ok(reads) => reads,
            Err(error) => {
                unreadable.get_or_insert(CoreError::from(error));
                continue;
            }
        };
        for read in reads {
            let active = read.result.map_err(CoreError::from).and_then(|session| {
                snapshot_active(
                    core,
                    &SessionRef {
                        project_id: project.registered.project_id.clone(),
                        session_id: session.id,
                    },
                )
            });
            match active {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(error) => {
                    unreadable.get_or_insert(error);
                }
            }
        }
    }
    // An unavailable unrelated root cannot hide known delivered work. Without
    // a positive observation, incomplete inspection stays an explicit error.
    unreadable.map_or(Ok(false), Err)
}

fn snapshot_active(core: &NativeCoreService, route: &SessionRef) -> Result<bool, CoreError> {
    let context = QueryContext::owner(OwnerContext::from_trusted_entrypoint(OwnerScope::Session(
        core.resolve_session(route)?,
    )));
    let request = QueryRequest::SessionGet {};
    let result = core.query(context.clone(), request.clone())?;
    result.validate_for(&context, &request)?;
    let QueryResult::SessionGet(snapshot) = result else {
        return Err(CoreError::new(
            CoreErrorCode::ProtocolConflict,
            "The remaining host-work snapshot is unavailable.",
            "Inspect the registered session after reopening Ariadne.",
        ));
    };
    Ok(active_delivered(&snapshot.session))
}

fn active_delivered(session: &Session) -> bool {
    let Some(binding) = session
        .active_binding_id
        .as_ref()
        .and_then(|id| session.bindings.0.get(id))
    else {
        return false;
    };
    let Some(input) = binding
        .active_input_id
        .as_ref()
        .and_then(|id| session.inputs.0.get(id))
    else {
        return false;
    };
    if input.binding_id != binding.id
        || !matches!(
            input.state,
            InputState::InFlight | InputState::NeedsAttention
        )
    {
        return false;
    }
    let Some(attempt) = input
        .active_attempt_id
        .as_ref()
        .and_then(|id| input.attempts.iter().find(|attempt| &attempt.id == id))
    else {
        return false;
    };
    attempt.binding_generation == binding.generation
        && attempt.sealed_at.is_none()
        && (attempt.acceptance == AcceptanceState::Accepted
            || attempt.turn_state == TurnState::Running)
        && matches!(attempt.turn_state, TurnState::Unknown | TurnState::Running)
}

#[cfg(target_os = "macos")]
pub(crate) fn present() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication};
    use objc2_foundation::NSString;

    let main = MainThreadMarker::new().expect("Quit note is scheduled on the app main thread");
    let alert = NSAlert::new(main);
    alert.setAlertStyle(NSAlertStyle::Informational);
    alert.setMessageText(&NSString::from_str(
        "Host work already sent can continue after Ariadne quits.",
    ));
    alert.setInformativeText(&NSString::from_str(
        "Queued, unsent inputs wait until you reopen Ariadne.",
    ));
    // Keep macOS 13 support. The replacement activate API requires macOS 14.
    #[allow(deprecated)]
    NSApplication::sharedApplication(main).activateIgnoringOtherApps(true);
    // NSAlert supplies its single default OK button. This is informational:
    // no Cancel, provider stop, renderer acknowledgement or new protocol.
    alert.runModal();
}

#[cfg(test)]
mod tests {
    use super::*;
    use ariadne_store::{registry::Registry, session::Store};

    fn fixture() -> Session {
        serde_json::from_str(include_str!(
            "../../../../../../fixtures/domain/demo/session.json"
        ))
        .unwrap()
    }
    fn active_input(session: &mut Session) -> &mut Input {
        let binding = &session.bindings.0[session.active_binding_id.as_ref().unwrap()];
        session
            .inputs
            .0
            .get_mut(binding.active_input_id.as_ref().unwrap())
            .unwrap()
    }
    fn active_attempt(session: &mut Session) -> &mut Attempt {
        let input = active_input(session);
        let id = input.active_attempt_id.clone().unwrap();
        input
            .attempts
            .iter_mut()
            .find(|attempt| attempt.id == id)
            .unwrap()
    }

    #[test]
    fn accepted_nonterminal_delivery_remains_active_after_result_publication_or_pause() {
        let mut session = fixture();
        assert!(active_delivered(&session));
        active_attempt(&mut session).turn_state = TurnState::Unknown;
        active_attempt(&mut session).host_turn_id = None;
        assert!(active_delivered(&session));
        active_input(&mut session).state = InputState::NeedsAttention;
        active_attempt(&mut session).result_state = ResultState::Committed;
        let id = session.active_binding_id.clone().unwrap();
        session.bindings.0.get_mut(&id).unwrap().owner_paused = true;
        session.bindings.0.get_mut(&id).unwrap().connection_state = ConnectionState::Disconnected;
        assert!(
            active_delivered(&session),
            "Result/owner Pause cannot stop a delivered host turn"
        );
    }

    #[test]
    fn observed_running_turn_is_delivered_even_before_acceptance_or_during_uncertainty() {
        for acceptance in [
            AcceptanceState::Prepared,
            AcceptanceState::Uncertain,
            AcceptanceState::Rejected,
        ] {
            let mut session = fixture();
            active_attempt(&mut session).acceptance = acceptance;
            assert!(active_delivered(&session));
        }
    }

    #[test]
    fn terminal_or_unconfirmed_turns_do_not_claim_continuing_host_work() {
        for state in [
            TurnState::Completed,
            TurnState::Failed,
            TurnState::Interrupted,
        ] {
            let mut session = fixture();
            active_attempt(&mut session).turn_state = state;
            assert!(!active_delivered(&session));
        }
        for state in [
            AcceptanceState::Prepared,
            AcceptanceState::Rejected,
            AcceptanceState::Uncertain,
        ] {
            let mut session = fixture();
            active_attempt(&mut session).acceptance = state;
            active_attempt(&mut session).turn_state = TurnState::Unknown;
            assert!(!active_delivered(&session));
        }
        let mut session = fixture();
        let at = session.updated_at.clone();
        active_attempt(&mut session).sealed_at = Some(at);
        assert!(!active_delivered(&session));
    }

    #[test]
    fn stale_generation_binding_or_historical_attempt_cannot_trigger_the_note() {
        let mut session = fixture();
        let other = session
            .bindings
            .0
            .values()
            .find(|binding| Some(&binding.id) != session.active_binding_id.as_ref())
            .unwrap()
            .clone();
        active_attempt(&mut session).binding_generation = other.generation;
        assert!(!active_delivered(&session));
        let mut session = fixture();
        active_input(&mut session).binding_id = other.id;
        assert!(!active_delivered(&session));
        let mut session = fixture();
        active_input(&mut session).active_attempt_id = None;
        assert!(!active_delivered(&session));
        let mut session = fixture();
        let id = session.active_binding_id.clone().unwrap();
        session.bindings.0.get_mut(&id).unwrap().active_input_id = None;
        assert!(!active_delivered(&session));
        session.active_binding_id = None;
        assert!(!active_delivered(&session));
    }

    #[test]
    fn queued_or_terminal_inputs_do_not_reuse_prior_delivery_as_active() {
        for state in [
            InputState::Queued,
            InputState::Handled,
            InputState::Cancelled,
            InputState::Skipped,
        ] {
            let mut session = fixture();
            active_input(&mut session).state = state;
            assert!(!active_delivered(&session));
        }
    }

    #[test]
    fn registered_core_read_is_observational_and_unreadable_data_is_not_no_active_work() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let registry = Registry::create_data_directory(&data).unwrap();
        let core = NativeCoreService::new(
            registry,
            || panic!("Read cannot allocate"),
            || panic!("Read cannot mutate time"),
            |_| panic!("Read cannot call a host"),
        );
        assert!(!required(&core).unwrap());
        let unavailable = root.path().join("unavailable");
        std::fs::create_dir(&unavailable).unwrap();
        core.registry()
            .register_fixed(
                &unavailable,
                &UuidV4::new("00000000-0000-4000-8000-000000000998").unwrap(),
                &UuidV4::new("00000000-0000-4000-8000-000000000997").unwrap(),
            )
            .unwrap();
        let session = fixture();
        let operation = UuidV4::new("00000000-0000-4000-8000-000000000999").unwrap();
        core.registry()
            .register_fixed(&project, &operation, &session.project_id)
            .unwrap();
        std::fs::remove_dir_all(&unavailable).unwrap();
        assert!(
            required(&core).is_err(),
            "Unreadable roots are not quiet work"
        );
        Store::open_registered(
            &core.registry().project_dir(&session.project_id),
            session.project_id.clone(),
        )
        .unwrap()
        .create(&session)
        .unwrap();
        let path = core
            .registry()
            .project_dir(&session.project_id)
            .join("sessions")
            .join(format!("{}.json", session.id.as_str()));
        let before = std::fs::read(&path).unwrap();
        assert!(required(&core).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::write(&path, b"invalid session").unwrap();
        assert!(required(&core).is_err());
    }
}
