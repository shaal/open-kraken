import { Component, type ReactNode } from "react";
import { logError } from "./log";

interface ErrorBoundaryProps {
  /** What failed, for the message and the log, for example "draw the commit graph". */
  action: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Shows an error instead of a blank window when its children throw while
 * rendering, and logs it. Give it a new `key` to try again with new children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`could not ${this.props.action}: ${message}`);
  }

  render() {
    const { error } = this.state;
    if (error) {
      return (
        <section role="alert" className="error">
          <p>
            Could not {this.props.action}: {error.message}
          </p>
        </section>
      );
    }
    return this.props.children;
  }
}
