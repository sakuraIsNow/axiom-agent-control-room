import { useEffect, useRef } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { useUiLanguage } from '../../lib/uiLanguage';

type ReviewAction = 'approve' | 'reject';

export function ReviewConfirmDialog({ action, note, busy, onCancel, onConfirm, partial = false }: {
  action: ReviewAction;
  note: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  partial?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const approving = action === 'approve';
  const partialApproval = approving && partial;
  const { language } = useUiLanguage();
  const zh = language === 'zh-CN';

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return <div className="dash-confirm-backdrop" role="presentation" onMouseDown={() => { if (!busy) onCancel(); }}>
    <section
      className={`dash-confirm-dialog dash-review-confirm ${approving ? 'approve' : 'reject'}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dash-review-confirm-title"
      onMouseDown={(event) => event.stopPropagation()}
      data-testid="review-confirm-dialog"
      data-i18n-ignore={partialApproval || undefined}
    >
      <span className="dash-confirm-icon">{approving ? <Check size={19} /> : <RotateCcw size={18} />}</span>
      <h2 id="dash-review-confirm-title">{partialApproval ? (zh ? '确认接受部分结果？' : 'Accept the partial result?') : approving ? '确认按当前结果交付？' : '确认让 Agent 重新整改？'}</h2>
      {partialApproval && <p>{zh ? '未满足项仍会保留，此操作不表示已验证正确。' : 'Unmet requirements remain recorded. This does not confirm the result is correct.'}</p>}
      {note.trim() && <p className="dash-review-confirm-note">{note.trim()}</p>}
      <div className="dash-confirm-actions">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>{partialApproval && !zh ? 'Cancel' : '取消'}</button>
        <button type="button" className={approving ? 'approve' : 'revise'} onClick={onConfirm} disabled={busy}>
          {partialApproval ? busy ? (zh ? '处理中…' : 'Processing...') : (zh ? '接受部分结果' : 'Accept Partial Result') : busy ? '处理中…' : approving ? '确认交付' : '重新规划并整改'}
        </button>
      </div>
    </section>
  </div>;
}
