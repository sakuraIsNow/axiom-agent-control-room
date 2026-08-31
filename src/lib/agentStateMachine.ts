import type { AgentPhase, TopologyAgent } from '../types';

export type AgentStateId =
  | '00' | '01'
  | '10'
  | '30' | '31' | '32' | '33' | '34' | '35';

export type AnimationPrimitive =
  | { type: 'sine'; amplitude: number; frequency: number }
  | { type: 'pulse'; amplitude: number; frequency: number }
  | { type: 'jitter'; amplitude: number; frequency: number }
  | { type: 'scan'; speed: number }
  | { type: 'glance'; intervalSec: number }
  | { type: 'blink'; intervalSec: number; durationSec: number };

export type AgentStateDef = {
  id: AgentStateId;
  label: string;
  staticOverrides: { scale: number; emissiveIntensity: number };
  primitives: AnimationPrimitive[];
  ribbonActive: boolean;
  settle: { zeta: number; omega: number };
};

const state = (
  id: AgentStateId,
  label: string,
  scale: number,
  emissiveIntensity: number,
  primitives: AnimationPrimitive[],
  ribbonActive = false,
  settle = { zeta: 1, omega: 8 },
): AgentStateDef => ({ id, label, staticOverrides: { scale, emissiveIntensity }, primitives, ribbonActive, settle });

export const AGENT_STATE_DEFS: Record<AgentStateId, AgentStateDef> = {
  '00': state('00', '未创建', 0, 0, []),
  '01': state('01', '启动中', 0.72, 0.28, [{ type: 'jitter', amplitude: 0.03, frequency: 6 }]),
  '10': state('10', '排队等待', 0.86, 0.32, [{ type: 'sine', amplitude: 0.04, frequency: 0.6 }, { type: 'blink', intervalSec: 3.2, durationSec: 0.18 }]),
  '30': state('30', '路由中', 0.96, 0.55, [{ type: 'scan', speed: 1.4 }, { type: 'glance', intervalSec: 2.1 }]),
  '31': state('31', '加载上下文', 0.98, 0.6, [{ type: 'pulse', amplitude: 0.05, frequency: 1.1 }]),
  '32': state('32', '推理中', 1.08, 1.05, [{ type: 'sine', amplitude: 0.07, frequency: 0.9 }, { type: 'jitter', amplitude: 0.015, frequency: 9 }], true, { zeta: 0.85, omega: 7 }),
  '33': state('33', '工具调用中', 1.1, 1.1, [{ type: 'pulse', amplitude: 0.09, frequency: 2.4 }], true, { zeta: 0.8, omega: 9 }),
  '34': state('34', '完成收尾', 1.02, 0.75, [{ type: 'sine', amplitude: 0.02, frequency: 0.4 }]),
  '35': state('35', '失败告警', 0.92, 0.9, [{ type: 'jitter', amplitude: 0.06, frequency: 4 }, { type: 'blink', intervalSec: 0.9, durationSec: 0.3 }]),
};

export function resolveAgentStateId(status: TopologyAgent['status'] | undefined, phase: AgentPhase): AgentStateId {
  if (!status || status === 'queued') return phase === 'idle' ? '00' : '10';
  if (status === 'failed') return '35';
  if (status === 'completed') return '34';
  if (phase === 'routing') return '30';
  if (phase === 'context') return '31';
  if (phase === 'inference') return '32';
  return '33';
}

/** Critically-damped spring integrator (borrowed formula, not borrowed visuals). */
export function springStep(x: number, v: number, target: number, dt: number, zeta = 1, omega = 8): readonly [number, number] {
  const a = -2 * zeta * omega * v - omega * omega * (x - target);
  const nv = v + a * dt;
  return [x + nv * dt, nv] as const;
}

export function evaluatePrimitive(primitive: AnimationPrimitive, t: number, seed: number): number {
  switch (primitive.type) {
    case 'sine':
      return Math.sin(t * primitive.frequency * Math.PI * 2 + seed) * primitive.amplitude;
    case 'pulse':
      return (Math.sin(t * primitive.frequency * Math.PI * 2 + seed) * 0.5 + 0.5) * primitive.amplitude;
    case 'jitter':
      return (Math.sin(t * primitive.frequency * 12.9898 + seed) * 43758.5453 % 1) * primitive.amplitude;
    case 'scan':
      return (t * primitive.speed) % 1;
    case 'glance': {
      const cycle = t % primitive.intervalSec;
      return cycle < 0.22 ? Math.sin((cycle / 0.22) * Math.PI) : 0;
    }
    case 'blink': {
      const cycle = t % primitive.intervalSec;
      return cycle < primitive.durationSec ? 1 : 0;
    }
    default:
      return 0;
  }
}

export function isRibbonActive(id: AgentStateId): boolean {
  return AGENT_STATE_DEFS[id].ribbonActive;
}
