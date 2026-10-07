import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RootBoundaryState { readonly error: Error | null }

/** The last stop for a render error: the window names it instead of going blank. */
export class RootBoundary extends Component<{ readonly children: ReactNode }, RootBoundaryState> {
  override state: RootBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): RootBoundaryState { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Ariadne could not render', error, info.componentStack); }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="root-failure" role="alert" data-root-failure>
      <h1>Ariadne could not render this view</h1>
      <p>Reopen the window to continue. If this keeps happening, report the message below.</p>
      <pre>{this.state.error.message}</pre>
    </main>;
  }
}
