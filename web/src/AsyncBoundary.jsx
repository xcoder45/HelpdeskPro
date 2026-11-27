import { Component } from 'react';

import { ErrorBanner } from './ui.jsx';

export default class AsyncBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previousProps) {
    if (this.state.failed && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="auth-screen">
          <section className="auth-card" role="alert">
            <h1>{this.props.title ?? 'This section could not be loaded'}</h1>
            <ErrorBanner message="The required code could not be downloaded. Check your connection and try again." />
            {this.props.onRetry && (
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  this.setState({ failed: false });
                  this.props.onRetry();
                }}
              >
                Try again
              </button>
            )}
            <button type="button" className="button button-secondary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
