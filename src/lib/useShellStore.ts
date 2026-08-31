import { create } from 'zustand';
import type { AgentGraph, AgentPhase, BudgetConstraint, CollaborationConflict, CollaborationMessage, RunEvent, TaskProfile, TopologyAgent, Usage } from '../types';

export type ShellView = 'core' | 'graph' | 'stream';

type ShellState = {
  view: ShellView;
  phase: AgentPhase;
  agents: TopologyAgent[];
  graph: AgentGraph | null;
  selectedNodeId: string | null;
  runEvents: RunEvent[];
  collaborationMessages: CollaborationMessage[];
  collaborationConflicts: CollaborationConflict[];
  budgetConstraints: BudgetConstraint[];
  usage: Usage;
  durationMs: number;
  taskProfile: TaskProfile | null;
  setView: (view: ShellView) => void;
  syncRuntime: (runtime: Partial<Omit<ShellState, 'setView' | 'syncRuntime'>>) => void;
  selectNode: (id: string | null) => void;
};

export const useShellStore = create<ShellState>((set) => ({
  view: 'core',
  phase: 'idle',
  agents: [],
  graph: null,
  selectedNodeId: null,
  runEvents: [],
  collaborationMessages: [],
  collaborationConflicts: [],
  budgetConstraints: [],
  usage: {},
  durationMs: 0,
  taskProfile: null,
  setView: (view) => set({ view }),
  syncRuntime: (runtime) => set(runtime),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
}));
