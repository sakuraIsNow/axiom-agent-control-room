import { useEffect, useState } from 'react';

export const useParallax = () => {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const onMove = (event: PointerEvent) => setOffset({
      x: (event.clientX / Math.max(window.innerWidth, 1) - 0.5) * 10,
      y: (event.clientY / Math.max(window.innerHeight, 1) - 0.5) * 8,
    });
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
  return offset;
};
