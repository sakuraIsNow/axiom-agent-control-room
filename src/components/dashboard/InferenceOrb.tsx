import { useEffect, useRef } from 'react';

export function InferenceOrb({ size = 46 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * ratio;
    canvas.height = size * ratio;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    context.scale(ratio, ratio);
    let frame = 0;

    const draw = (timestamp: number) => {
      const time = timestamp / 1000;
      const center = size / 2;
      const radius = size * .29;
      context.clearRect(0, 0, size, size);

      context.save();
      context.beginPath();
      for (let index = 0; index <= 48; index += 1) {
        const angle = index / 48 * Math.PI * 2;
        const movement = reducedMotion ? 0 : Math.sin(angle * 3 + time * 2.2) * 1.4 + Math.cos(angle * 5 - time * 1.3) * .7;
        const pointRadius = radius + movement;
        const x = center + Math.cos(angle) * pointRadius;
        const y = center + Math.sin(angle) * pointRadius;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.closePath();
      context.shadowColor = 'rgba(43, 234, 120, .55)';
      context.shadowBlur = 15;
      const fill = context.createRadialGradient(center - radius * .45, center - radius * .55, 1, center, center, radius * 1.3);
      fill.addColorStop(0, 'rgba(246, 255, 251, .98)');
      fill.addColorStop(.2, 'rgba(117, 255, 171, .92)');
      fill.addColorStop(.62, 'rgba(22, 178, 86, .88)');
      fill.addColorStop(1, 'rgba(3, 55, 25, .94)');
      context.fillStyle = fill;
      context.fill();
      context.clip();
      context.shadowBlur = 0;
      context.fillStyle = 'rgba(255, 255, 255, .28)';
      context.beginPath();
      context.ellipse(center - radius * .3, center - radius * .42, radius * .34, radius * .15, -.55, 0, Math.PI * 2);
      context.fill();
      context.restore();

      context.save();
      context.translate(center, center);
      context.rotate(reducedMotion ? -.18 : time * .85);
      const ribbon = context.createLinearGradient(-radius * 1.7, 0, radius * 1.7, 0);
      ribbon.addColorStop(0, 'rgba(116, 209, 255, 0)');
      ribbon.addColorStop(.28, 'rgba(116, 209, 255, .86)');
      ribbon.addColorStop(.58, 'rgba(191, 122, 255, .92)');
      ribbon.addColorStop(.82, 'rgba(43, 234, 120, .86)');
      ribbon.addColorStop(1, 'rgba(43, 234, 120, 0)');
      context.strokeStyle = ribbon;
      context.lineWidth = 2.2;
      context.shadowColor = 'rgba(128, 220, 255, .7)';
      context.shadowBlur = 8;
      context.beginPath();
      context.ellipse(0, 0, radius * 1.55, radius * .48, 0, 0, Math.PI * 2);
      context.stroke();
      context.restore();

      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [size]);

  return <canvas ref={canvasRef} className="dash-inference-orb" aria-label="模型正在生成" />;
}
