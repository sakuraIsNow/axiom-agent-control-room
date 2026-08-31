import { useEffect, useState } from 'react';

export function CountUp({ value }: { value: number }) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const start = display;
    const started = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - started) / 520);
      setDisplay(Math.round(start + (value - start) * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  if (display >= 1_000_000) return <>{(display / 1_000_000).toFixed(1)}M</>;
  if (display >= 1_000) return <>{(display / 1_000).toFixed(1)}K</>;
  return <>{display}</>;
}
