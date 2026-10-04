#[path = "../../../tests/functional/mcp/process.rs"]
mod process;
#[test]
fn standalone_sdk_persists_complete_history_and_replays_one_receipt_across_real_process_races() {
    process::persisted_race_and_parity(env!("CARGO_BIN_EXE_ariadne-mcp"), &["serve"], None);
}
#[test]
fn standalone_raw_split_boundary_overflow_and_eof_never_dispatch_partial_input() {
    process::raw_frame_contract(env!("CARGO_BIN_EXE_ariadne-mcp"), &["serve"]);
}

#[test]
fn real_native_scope_keeps_private_owner_history_and_exact_replay_after_rotation() {
    process::native_scope_and_historical_replay(env!("CARGO_BIN_EXE_ariadne-mcp"), &["serve"]);
}
