import { lazy, useRef, useState } from 'react';

// React caches a rejected lazy import, so retrying requires a fresh lazy
// component type. Keep one per attempt and expose a callback that creates it.
export default function useRetryableLazy(factory) {
  const [attempt, setAttempt] = useState(0);
  const loaders = useRef(new Map());

  if (!loaders.current.has(attempt)) {
    loaders.current.set(attempt, lazy(factory));
  }

  return [loaders.current.get(attempt), () => setAttempt((value) => value + 1), attempt];
}
