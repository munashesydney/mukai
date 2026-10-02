import { Component, type ErrorInfo, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Mukai renderer error', error, info.componentStack);
  }
  render() {
    return this.state.failed ? (
      <main className="error-screen">
        <h1>Let’s wake this workspace back up.</h1>
        <p>Something unexpected happened. Reload to return to your workspace.</p>
        <button className="button button--primary" onClick={() => window.location.reload()}>
          Reload Mukai
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
