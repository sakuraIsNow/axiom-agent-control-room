import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';

export function DeleteConfirmDialog({ busy, onCancel, onConfirm }: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return <div className="dash-confirm-backdrop" role="presentation" onMouseDown={() => { if (!busy) onCancel(); }}>
    <section className="dash-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dash-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
      <span className="dash-confirm-icon"><Trash2 size={18} /></span>
      <h2 id="dash-confirm-title">确认删除？</h2>
      <div className="dash-confirm-actions">
        <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button type="button" className="danger" onClick={onConfirm} disabled={busy}>{busy ? '删除中…' : '删除'}</button>
      </div>
    </section>
  </div>;
}
