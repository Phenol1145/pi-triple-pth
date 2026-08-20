import { Component, type ComponentChildren } from "preact";
import { Button } from "../ui";

export interface ErrorBoundaryProps {
  children: ComponentChildren;
  /** Short label for the region being guarded, used in the fallback copy. */
  region?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Render-failure guard. A crashing subtree shows a retryable fallback
 * instead of blanking the whole console.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Client-side log only; the message is a runtime Error, not server HTML.
    console.error("operator-console: render failure", error.message);
  }

  private readonly retry = () => {
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error) {
      return (
        <div class="error-boundary" role="alert">
          <p class="error-boundary__title">
            {this.props.region ?? "此区域"}渲染失败
          </p>
          <p class="error-boundary__detail">
            界面组件发生异常，其余功能不受影响。
          </p>
          <Button variant="primary" onClick={this.retry}>
            重试
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
