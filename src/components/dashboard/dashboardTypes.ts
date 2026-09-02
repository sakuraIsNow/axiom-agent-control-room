import type { ReactNode } from 'react';
import type { AgentGraph, AgentMode, AgentPhase, FileAttachment, ImageAttachment, Session, TaskProfile, TopologyAgent, WorkflowTaskSummary } from '../../types';
import type { UiTheme } from '../../lib/uiTheme';

export type ReviewResultState = { approved: boolean; score: number; summary: string; gaps: string[]; requiredCorrections: string[] };
export type GuidanceState = {
  guidanceId: string;
  status: 'accepted' | 'applied';
  delivery: 'builtin-next-safe-point' | 'external-harness';
  message: string;
  applicationPoint?: string;
};
export type RouteInsightState = {
  route: string;
  reason: string;
  confidence?: number;
  agentIds: string[];
  skillIds: string[];
  source?: string;
};

export type DashboardProps = {
  phase: AgentPhase;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
  onRefreshTemplates: () => void;
  templateWorkspace: ReactNode;
  onOpenPlugins: () => void;
  pluginWorkspace: ReactNode;
  onOpenReadiness: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  isRunning: boolean;
  canGuide: boolean;
  guidanceBusy: boolean;
  guidanceState: GuidanceState | null;
  onGuidance: () => void;
  routeInsight: RouteInsightState | null;
  /** Latest user-facing activity derived from a real gateway or workflow event. */
  agentActivity: string;
  theme: UiTheme;
  agents: TopologyAgent[];
  graph: AgentGraph | null;
  selectedNodeId: string | null;
  onSelectAgent: (id: string) => void;
  taskProfile: TaskProfile | null;
  reviewResult: ReviewResultState | null;
  reviewApprovalTaskId: string | null;
  reviewNote: string;
  reviewActionBusy: boolean;
  onReviewNoteChange: (value: string) => void;
  onApproveReview: () => Promise<boolean>;
  onRejectReview: () => Promise<boolean>;
  taskCatalog: WorkflowTaskSummary[];
  onOpenTask: (taskId: string) => void;
  /**
   * Delete a task run. Task boards may provide all run IDs represented by a
   * grouped card so the visible card disappears in one user action.
   */
  onDeleteTask: (taskId: string, taskIds?: string[]) => Promise<boolean>;
  sessionId: string;
  sessions: Session[];
  activeSession: Session;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  attachments: Array<ImageAttachment | FileAttachment>;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  error: string | null;
  readiness: 'ready' | 'degraded' | 'blocked';
  provider: string;
  textModelCredentialId?: string;
  onThemeChange: (theme: UiTheme) => void;
  principalUserId?: string;
};
