import { ArrowUpRight, MessageSquareText, Puzzle, Workflow, X } from 'lucide-react';
import type { DashboardNavItem } from '../../lib/useDashboardStore';

type FirstRunGuideProps = {
  onStartConversation: () => void;
  onOpenWorkspace: (workspace: Extract<DashboardNavItem, 'plugins' | 'workflows'>) => void;
  onDismiss: () => void;
};

const entries = [
  {
    id: 'chat',
    eyebrow: '直接开始',
    title: '发起第一次对话',
    detail: '让路由 Agent 按目标选择能力',
    icon: MessageSquareText,
  },
  {
    id: 'plugins',
    eyebrow: '做一个小工具',
    title: '创建插件',
    detail: '从空白插件开始与 Agent 共创',
    icon: Puzzle,
  },
  {
    id: 'workflows',
    eyebrow: '编排协作',
    title: '搭建 Agent Nexus',
    detail: '组合 Agent、分支与 Loop',
    icon: Workflow,
  },
] as const;

export function FirstRunGuide({ onStartConversation, onOpenWorkspace, onDismiss }: FirstRunGuideProps) {
  const select = (id: (typeof entries)[number]['id']) => {
    if (id === 'chat') onStartConversation();
    else onOpenWorkspace(id);
  };

  return <div className="dash-first-run-layer" role="presentation">
    <section className="dash-first-run-guide" role="dialog" aria-labelledby="dash-first-run-title">
      <header>
        <div>
          <span>开始工作</span>
          <h1 id="dash-first-run-title">今天想交付什么？</h1>
        </div>
        <button type="button" aria-label="关闭首次使用引导" title="以后不再显示" onClick={onDismiss}><X size={17} /></button>
      </header>
      <div className="dash-first-run-options">
        {entries.map((entry, index) => {
          const Icon = entry.icon;
          return <button key={entry.id} type="button" data-destination={entry.id} onClick={() => select(entry.id)}>
            <span className="dash-first-run-index">0{index + 1}</span>
            <span className="dash-first-run-icon"><Icon size={19} /></span>
            <span className="dash-first-run-copy"><small>{entry.eyebrow}</small><strong>{entry.title}</strong><em>{entry.detail}</em></span>
            <ArrowUpRight className="dash-first-run-arrow" size={17} />
          </button>;
        })}
      </div>
      <footer><button type="button" onClick={onDismiss}>暂不引导</button></footer>
    </section>
  </div>;
}
