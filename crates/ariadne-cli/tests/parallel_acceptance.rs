#[path = "../../../tests/functional/acceptance/parallel_cli.rs"]
mod parallel_cli;

#[test]
fn installed_cli_keeps_parallel_queued_results_and_events_in_their_own_lane() {
    parallel_cli::parallel_queued_isolation(env!("CARGO_BIN_EXE_ariadne"));
}
