import { ArrowLeft, CircleHelp, Settings2, Sparkles } from 'lucide-react';
import type { AgentPhase } from '../../types';
import type { UiTheme } from '../../lib/uiTheme';
import { ThemePicker } from '../ThemePicker';
import { LanguagePicker } from '../LanguagePicker';

const phaseLabel: Record<AgentPhase, string> = { idle: '待命', routing: '路由分析', context: '装配上下文', inference: '模型推理', complete: '已交付', error: '异常' };

export function ShellHeader({ phase, provider, theme, onThemeChange, onNewTask, onOpenSettings, onBack }: { phase: AgentPhase; provider: string; theme: UiTheme; onThemeChange: (theme: UiTheme) => void; onNewTask: () => void; onOpenSettings: () => void; onBack: () => void }) {
  return <header className="shell-header">
    <button type="button" className="shell-brand" onClick={onNewTask}><span className="shell-brand-mark"><Sparkles size={15} /></span><span><strong>AXIOM</strong><small>Agent 控制中心</small></span></button>
    <div className="shell-header-state"><i className={`shell-state-dot ${phase}`} /><span>{phaseLabel[phase]}</span><em /> <b>{provider}</b></div>
    <div className="shell-header-actions"><button type="button" title="系统状态" aria-label="系统状态"><CircleHelp size={16} /></button><button type="button" title="运行设置" aria-label="运行设置" onClick={onOpenSettings}><Settings2 size={16} /></button><ThemePicker value={theme} onChange={onThemeChange} /><LanguagePicker /><button type="button" title="返回任务台" aria-label="返回任务台" onClick={onBack}><ArrowLeft size={16} /></button></div>
  </header>;
}
