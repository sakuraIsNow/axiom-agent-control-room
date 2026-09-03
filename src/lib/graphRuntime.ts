export type GraphRuntimeSignals = {
  prefersReducedMotion: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  saveData?: boolean;
};

export type VirtualWindow = {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
};

export const shouldReduceGraphMotion = ({
  prefersReducedMotion,
  hardwareConcurrency,
  deviceMemory,
  saveData,
}: GraphRuntimeSignals) => (
  prefersReducedMotion
  || saveData === true
  || (hardwareConcurrency !== undefined && hardwareConcurrency <= 4)
  || (deviceMemory !== undefined && deviceMemory <= 4)
);

export const graphVirtualWindow = (
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 40,
  overscan = 5,
): VirtualWindow => {
  const safeCount = Math.max(0, Math.floor(itemCount));
  const safeRowHeight = Math.max(1, rowHeight);
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const firstVisible = Math.floor(Math.max(0, scrollTop) / safeRowHeight);
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / safeRowHeight));
  const start = Math.max(0, firstVisible - safeOverscan);
  const end = Math.min(safeCount, firstVisible + visibleCount + safeOverscan);
  return {
    start,
    end,
    paddingTop: start * safeRowHeight,
    paddingBottom: Math.max(0, (safeCount - end) * safeRowHeight),
  };
};
