import { Component } from 'react';

// Isolates a subtree so an error inside it (e.g. a text-editor label component)
// can't unmount the rest of the app — the surrounding UI (topbar, canvas,
// Təqdimat button…) keeps working. Resets when `resetKey` changes.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.error('Panel crashed (isolated):', err);
  }
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }
  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
