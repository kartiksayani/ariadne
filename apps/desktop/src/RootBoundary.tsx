import { Component, type ErrorInfo, type ReactNode } from 'react';

interface RootBoundaryProps {
  readonly children: ReactNode;
  /** Reloads the window; injectable for tests. */
  readonly reload?: () => void;
}
interface RootBoundaryState { readonly error: Error | null }

/** The last stop for a render error: the window names it and offers a reload instead of going blank. */
export class RootBoundary extends Component<RootBoundaryProps, RootBoundaryState> {
  override state: RootBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): RootBoundaryState { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error('Ariadne could not render', error, info.componentStack); }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const reload = this.props.reload ?? (() => window.location.reload());
    return <main className="root-failure" role="alert" data-root-failure>
      <h1>Ariadne could not render this view</h1>
      <p>Reload to continue. Your saved questions and answers are kept. If this keeps happening, report the message below.</p>
      <button type="button" className="btn btn-primary" onClick={reload}>Reload</button>
      <pre>{this.state.error.message}</pre>
    </main>;
  }
}
