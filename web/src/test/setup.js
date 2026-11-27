import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// Warm the lazy chart chunk so jsdom assertions see it on the first navigation.
await import('../AnalyticsPanel.jsx');

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

const CHART_SIZE = { width: 800, height: 260 };

class ResizeObserverMock {
  constructor(callback) {
    this.callback = callback;
  }

  observe(target) {
    this.callback([{ target, contentRect: CHART_SIZE }], this);
  }

  unobserve() {}

  disconnect() {}
}

globalThis.ResizeObserver = globalThis.ResizeObserver ?? ResizeObserverMock;

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  if (this.classList?.contains('recharts-responsive-container')) {
    return {
      ...CHART_SIZE,
      top: 0,
      left: 0,
      right: CHART_SIZE.width,
      bottom: CHART_SIZE.height,
      x: 0,
      y: 0,
      toJSON() { return { ...CHART_SIZE }; }
    };
  }
  return originalGetBoundingClientRect.call(this);
};
