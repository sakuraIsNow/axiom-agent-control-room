import { useMemo } from 'react';
import { Activity } from 'lucide-react';
import type { TaskStatsDaily } from '../../types';

export function TokenTrendSparkline({ points }: { points: TaskStatsDaily[] }) {
  const values = useMemo(() => points.length ? points.map((point) => point.totalTokens) : Array.from({ length: 7 }, () => 0), [points]);
  const max = Math.max(1, ...values);
  const path = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 28 - (value / max) * 22;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
  const total = values.reduce((sum, value) => sum + value, 0);
  return <section className="dash-token-trend" aria-label="近七日 Token 趋势">
    <div className="dash-token-trend-heading"><span><Activity size={13} />近七日 Token 消耗</span><strong>{total.toLocaleString()} Token</strong></div>
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="M 0 28 L 100 28" className="dash-sparkline-baseline" /><path d={path} className="dash-sparkline-path" /></svg>
    <div className="dash-token-trend-foot"><span>{points[0]?.date ?? '暂无数据'}</span><span>{points.at(-1)?.date ?? '暂无数据'}</span></div>
  </section>;
}
