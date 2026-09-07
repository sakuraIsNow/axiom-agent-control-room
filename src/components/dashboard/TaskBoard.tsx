import { useMemo, useState } from 'react';
import { Layers3, Trash2 } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import type { AgentGraph, WorkflowTaskSummary } from '../../types';
import { computeGraphLayers } from '../../lib/graphLayers';
import { nodeId, nodeTitle, taskStatusColor, taskStatusLabels } from '../../lib/graphPresentation';
import { groupTaskRuns } from '../../lib/taskGrouping';

const taskStatusIcon: Record<WorkflowTaskSummary['status'], string> = {
  queued: 'M12 4v16 M4 12h16',
  planning: 'M6 5h12v14H6z M9 9h6 M9 13h6',
  awaiting_approval: 'M12 4v9 M12 17v1',
  running: 'M7 5v14 M17 5v14',
  reviewing: 'M12 4v16 M4 12h16',
  waiting_for_human: 'M5 5h14v14H5z',
  paused: 'M7 5v14 M17 5v14',
  completed: 'M4 12l5 5L20 6 M9 17l0 0',
  failed: 'M6 6l12 12 M18 6L6 18',
  cancelled: 'M6 6l12 12 M18 6L6 18',
};

export function TaskBoard({ tasks, graph, selectedTaskId, currentUserId, onSelectTask, onDeleteTask }: { tasks: WorkflowTaskSummary[]; graph: AgentGraph | null; selectedTaskId: string | null; currentUserId: string; onSelectTask: (id: string) => void; onDeleteTask: (id: string, taskIds: string[]) => void }) {
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const visibleTasks = useMemo(() => groupTaskRuns(scope === 'mine' && currentUserId ? tasks.filter((task) => task.userId === currentUserId) : tasks), [currentUserId, scope, tasks]);
  const layers = computeGraphLayers(graph);
  return <div className="dash-task-board">
    {layers.length > 0 && <div className="dash-task-board-layers">
      <div className="dash-task-board-layers-head"><Layers3 size={14} /><span>当前任务依赖层级</span></div>
      {layers.map((layer) => <div key={layer.level} className="dash-task-layer">
        <span className="dash-task-layer-index">L{layer.level}</span>
        <div className="dash-task-layer-nodes">{layer.nodes.map((node, index) => <span key={`${nodeId(node)}-${index}`} className={`dash-task-layer-node status-${node.status ?? 'queued'}`}>{nodeTitle(node)}</span>)}</div>
      </div>)}
    </div>}
    <div className="dash-task-list">
      <div className="dash-task-tabs" role="tablist" aria-label="任务范围"><button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>全部</button><button type="button" className={scope === 'mine' ? 'active' : ''} onClick={() => setScope('mine')}>我的任务</button></div>
      <div className="dash-task-list-items">
        {visibleTasks.length === 0 && <div className="dash-empty">{scope === 'mine' ? '暂无分配给你的任务' : '暂无任务，提交一个目标后将出现在这里。'}</div>}
        {visibleTasks.map(({ task, count, sessionCount, taskIds }, index) => <div className="dash-task-item" key={`${task.sessionId || task.id}-${index}`}>
        <button
          type="button"
          data-session-id={task.sessionId}
          data-task-id={task.id}
          className={`dash-task-row status-${taskStatusColor(task.status)} ${taskIds.includes(selectedTaskId ?? '') ? 'selected' : ''}`}
          onClick={() => onSelectTask(task.id)}
        >
          <span className="dash-task-row-title" data-i18n-ignore="true">{task.title}</span>
          <span className="dash-task-row-meta">{count} 次运行 · {sessionCount} 个会话</span>
          <span className="dash-task-row-status"><MorphIcon icon={taskStatusIcon[task.status]} size={13} strokeWidth={2} spring="snappy" reducedMotion="user" />{taskStatusLabels[task.status]}</span>
        </button>
        {['completed', 'failed', 'cancelled'].includes(task.status) && <button
          type="button"
          className="dash-task-delete"
          aria-label={`删除任务 ${task.title}`}
          title="删除任务"
          onClick={() => onDeleteTask(task.id, taskIds.filter((id) => {
            const run = tasks.find((candidate) => candidate.id === id);
            return run ? ['completed', 'failed', 'cancelled'].includes(run.status) : false;
          }))}
        ><Trash2 size={13} /></button>}
        </div>)}
      </div>
    </div>
  </div>;
}
