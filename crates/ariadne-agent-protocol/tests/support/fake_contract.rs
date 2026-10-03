use super::*;
#[path = "common.rs"]
mod common;
use common::*;
use std::task::{Context, Poll, Waker};
fn ready<T>(mut future: AdapterFuture<'_, T>) -> Result<T, AdapterError> {
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("Scripted response unexpectedly waited"),
    }
}

fn connection(mode: DeliveryMode) -> (ConnectRequest, ConnectResult) {
    let request = ConnectRequest {
        binding_id: id('a'),
        generation: id('b'),
        external_session_id: "opaque session/α".into(),
        endpoint: EndpointRef::LocalBridge {
            name: "registered-test-bridge".into(),
        },
        configuration: AdapterConfig {
            namespace: "test".into(),
            values: ariadne_domain::models::UniqueMap(Default::default()),
        },
    };
    let mut events = events();
    let EventPayload::Connected {
        external_session_id,
        endpoint_fingerprint,
        mut capabilities,
    } = events.remove(0).event
    else {
        panic!()
    };
    capabilities.delivery_mode = mode;
    let EventPayload::Presence { observation } = events.remove(7).event else {
        panic!()
    };
    (
        request,
        ConnectResult {
            external_session_id,
            endpoint_fingerprint,
            capabilities: *capabilities,
            observation,
        },
    )
}
fn submit() -> SubmitRequest {
    SubmitRequest {
        binding_id: id('a'),
        generation: id('b'),
        input_id: id('c'),
        attempt_id: id('d'),
        formatted_payload: "exact persisted dispatch\ntext".into(),
        payload_sha256: Sha256::new("a".repeat(64)).unwrap(),
        wire_marker: "persisted-marker".into(),
    }
}

#[test]
fn both_delivery_modes_use_six_owned_object_safe_methods_and_commit_driven_checkpoints() {
    for mode in [DeliveryMode::Pull, DeliveryMode::Push] {
        let (connect, result) = connection(mode.clone());
        let probe = ProbeRequest {
            endpoint: connect.endpoint.clone(),
            configuration: connect.configuration.clone(),
        };
        let submit = submit();
        let observe = observe();
        let mut advanced = observe.clone();
        advanced.checkpoint = Some(Checkpoint::new("persisted-through-batch").unwrap());
        let observed = ObserveResult {
            events: vec![events()[1].clone(), events()[5].clone()],
            next_checkpoint: advanced.checkpoint.clone(),
        };
        let reconcile = reconcile();
        let evidence = ReconcileResult {
            attempt_evidence: vec![AttemptEvidence {
                input_id: id('c'),
                attempt_id: id('d'),
                events: vec![events()[5].clone()],
            }],
            unresolved_attempt_ids: vec![id('d')],
            next_checkpoint: Some(Checkpoint::new("historical-batch").unwrap()),
        };
        let disconnect = DisconnectRequest {
            binding_id: id('a'),
            generation: id('b'),
        };
        let steps = vec![
            ScriptStep {
                request: RecordedRequest::Probe(probe.clone()),
                response: ScriptedResponse::Probe(Ok(ProbeResult {
                    host_version: None,
                    compatibility: Compatibility::Unknown,
                    availability: Availability::Unknown,
                    setup_steps: vec![],
                })),
            },
            ScriptStep {
                request: RecordedRequest::Connect(connect.clone()),
                response: ScriptedResponse::connect(Ok(result)),
            },
            ScriptStep {
                request: RecordedRequest::Submit(submit.clone()),
                response: ScriptedResponse::Submit(Ok(SubmitOutcome::Uncertain {
                    reason: "Sender lost after possible send".into(),
                })),
            },
            ScriptStep {
                request: RecordedRequest::Observe(observe.clone()),
                response: ScriptedResponse::Observe(Ok(observed.clone())),
            },
            ScriptStep {
                request: RecordedRequest::Observe(observe.clone()),
                response: ScriptedResponse::Observe(Ok(observed.clone())),
            },
            ScriptStep {
                request: RecordedRequest::Observe(advanced.clone()),
                response: ScriptedResponse::Observe(Ok(ObserveResult {
                    events: vec![],
                    next_checkpoint: advanced.checkpoint.clone(),
                })),
            },
            ScriptStep {
                request: RecordedRequest::Reconcile(reconcile.clone()),
                response: ScriptedResponse::Reconcile(Ok(evidence.clone())),
            },
            ScriptStep {
                request: RecordedRequest::Disconnect(disconnect.clone()),
                response: ScriptedResponse::Disconnect(Ok(DisconnectResult {})),
            },
        ];
        let expected: Vec<_> = steps.iter().map(|step| step.request.clone()).collect();
        let fake = ScriptedAdapter::new(steps);
        let adapter: &dyn Adapter = &fake;
        assert_eq!(
            ready(adapter.probe(probe)).unwrap().compatibility,
            Compatibility::Unknown
        );
        assert_eq!(
            ready(adapter.connect(connect))
                .unwrap()
                .capabilities
                .delivery_mode,
            mode
        );
        assert!(matches!(
            ready(adapter.submit(submit)).unwrap(),
            SubmitOutcome::Uncertain { .. }
        ));
        assert_eq!(ready(adapter.observe(observe.clone())).unwrap(), observed);
        assert_eq!(ready(adapter.observe(observe)).unwrap(), observed); // caller has not persisted/advanced
        assert!(ready(adapter.observe(advanced)).unwrap().events.is_empty());
        assert_eq!(ready(adapter.reconcile(reconcile)).unwrap(), evidence); // only historical facts, no resend
        ready(adapter.disconnect(disconnect)).unwrap();
        assert_eq!(fake.remaining().unwrap(), 0);
        assert_eq!(fake.history().unwrap(), expected);
        assert_eq!(
            expected
                .iter()
                .filter(|request| matches!(request, RecordedRequest::Submit(_)))
                .count(),
            1
        );
    }
}

#[test]
fn exact_persisted_payload_mismatch_and_exhausted_scripts_fail_without_hidden_delivery() {
    let request = submit();
    let fake = ScriptedAdapter::new([ScriptStep {
        request: RecordedRequest::Submit(request.clone()),
        response: ScriptedResponse::Submit(Ok(SubmitOutcome::RejectedBeforeDelivery {
            reason: "Proven before delivery".into(),
        })),
    }]);
    let mut changed = request.clone();
    changed.formatted_payload.push('!');
    assert_eq!(
        ready(fake.submit(changed)).unwrap_err().code,
        AdapterErrorCode::ProtocolConflict
    );
    assert_eq!(fake.remaining().unwrap(), 1);
    assert!(matches!(
        ready(fake.submit(request.clone())).unwrap(),
        SubmitOutcome::RejectedBeforeDelivery { .. }
    ));
    assert!(ready(fake.submit(request)).is_err());
    assert_eq!(fake.history().unwrap().len(), 3);
    let request = submit();
    let fake = ScriptedAdapter::new([ScriptStep {
        request: RecordedRequest::Submit(request.clone()),
        response: ScriptedResponse::Submit(Err(AdapterError {
            code: AdapterErrorCode::DeliveryUncertain,
            message: "possibly sent".into(),
            retryable: false,
        })),
    }]);
    assert_eq!(
        ready(fake.submit(request)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
}

#[test]
fn mismatched_response_methods_and_bounded_typed_errors_are_rejected() {
    let (connect, _) = connection(DeliveryMode::Pull);
    let requests = vec![
        RecordedRequest::Probe(ProbeRequest {
            endpoint: connect.endpoint.clone(),
            configuration: connect.configuration.clone(),
        }),
        RecordedRequest::Connect(connect),
        RecordedRequest::Submit(submit()),
        RecordedRequest::Observe(observe()),
        RecordedRequest::Reconcile(reconcile()),
        RecordedRequest::Disconnect(DisconnectRequest {
            binding_id: id('a'),
            generation: id('b'),
        }),
    ];
    for request in requests {
        let response = if matches!(request, RecordedRequest::Probe(_)) {
            ScriptedResponse::Disconnect(Ok(DisconnectResult {}))
        } else {
            ScriptedResponse::Probe(Ok(ProbeResult {
                host_version: None,
                compatibility: Compatibility::Unknown,
                availability: Availability::Unknown,
                setup_steps: vec![],
            }))
        };
        let fake = ScriptedAdapter::new([ScriptStep {
            request: request.clone(),
            response,
        }]);
        let code = match request {
            RecordedRequest::Probe(request) => ready(fake.probe(request)).unwrap_err().code,
            RecordedRequest::Connect(request) => ready(fake.connect(request)).unwrap_err().code,
            RecordedRequest::Submit(request) => ready(fake.submit(request)).unwrap_err().code,
            RecordedRequest::Observe(request) => ready(fake.observe(request)).unwrap_err().code,
            RecordedRequest::Reconcile(request) => ready(fake.reconcile(request)).unwrap_err().code,
            RecordedRequest::Disconnect(request) => {
                ready(fake.disconnect(request)).unwrap_err().code
            }
        };
        assert_eq!(code, AdapterErrorCode::ProtocolConflict);
    }
    let request = observe();
    let error = AdapterError {
        code: AdapterErrorCode::HostUnreachable,
        message: "Reconnect the selected endpoint".into(),
        retryable: true,
    };
    let fake = ScriptedAdapter::new([ScriptStep {
        request: RecordedRequest::Observe(request.clone()),
        response: ScriptedResponse::Observe(Err(error.clone())),
    }]);
    assert_eq!(ready(fake.observe(request.clone())).unwrap_err(), error);
    let mut unbounded = error;
    unbounded.message = "x".repeat(4097);
    let fake = ScriptedAdapter::new([ScriptStep {
        request: RecordedRequest::Observe(request.clone()),
        response: ScriptedResponse::Observe(Err(unbounded)),
    }]);
    assert_eq!(
        ready(fake.observe(request)).unwrap_err().code,
        AdapterErrorCode::InvalidArgument
    );
}

#[test]
fn selected_identity_and_current_generation_are_checked_without_core_effects() {
    let (request, mut result) = connection(DeliveryMode::Pull);
    result.external_session_id = "another-session".into();
    assert_eq!(
        result.validate_for(&request).unwrap_err().code,
        AdapterErrorCode::BindingMismatch
    );
    result.external_session_id = request.external_session_id.clone();
    result.observation.generation = id('f');
    assert!(result.validate_for(&request).is_err());
    result.observation.generation = request.generation.clone();
    result.validate_for(&request).unwrap();
    result.endpoint_fingerprint.0 = "x".repeat(4097);
    assert!(result.validate_for(&request).is_err());
    let mut invalid = request;
    invalid.external_session_id.clear();
    assert!(invalid.validate().is_err());
}
