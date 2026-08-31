import { useEffect, useRef } from 'react';
import { Check, RotateCcw } from 'lucide-react';

type ReviewAction = 'approve' | 'reject';

export function ReviewConfirmDialog({ action, note, busy, onCancel, onConfirm }: {
  action: ReviewAction;
  note: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const approving = action === 'approve';

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
    >
      <span className="dash-confirm-icon">{approving ? <Check size={19} /> : <RotateCcw size={18} />}</span>
      <h2 id="dash-review-confirm-title">{approving ? '确认按当前结果交付？' : '确认让 Agent 重新整改？'}</h2>
      {note.trim() && <p className="dash-review-confirm-note">{note.trim()}</p>}
      <div className="dash-confirm-actions">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button type="button" className={approving ? 'approve' : 'revise'} onClick={onConfirm} disabled={busy}>
          {busy ? '处理中…' : approving ? '确认交付' : '重新规划并整改'}
        </button>
      </div>
    </section>
  </div>;
}
