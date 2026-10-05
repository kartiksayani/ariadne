// Keep signal handlers installed until the caller's ordinary finally completes.
// The caller owns cleanup; cancellation never searches for or kills a process.
export async function withCancellation(run) {
  const controller = new globalThis.AbortController();
  const interrupt = name => controller.abort(new Error(`Window acceptance interrupted by ${name}`));
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const result = await run(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
