import { useEffect, useRef, useState } from 'react';
import { Check, Languages } from 'lucide-react';
import { useUiLanguage, type UiLanguage } from '../lib/uiLanguage';

const options: Array<{ id: UiLanguage; label: string; shortLabel: string }> = [
  { id: 'en', label: 'English', shortLabel: 'EN' },
  { id: 'zh-CN', label: '简体中文', shortLabel: '中' },
];

export function LanguagePicker() {
  const { language, setLanguage } = useUiLanguage();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeWithKeyboard);
    };
  }, [open]);

  const active = options.find((option) => option.id === language) ?? options[0]!;
  const heading = language === 'en' ? 'Language' : '界面语言';

  return <div ref={rootRef} className="language-picker-control">
    <button
      type="button"
      className="language-trigger"
      title={language === 'en' ? `Language: ${active.label}` : `语言：${active.label}`}
      aria-label={language === 'en' ? `Choose language. Current: ${active.label}` : `选择语言，当前为${active.label}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
    >
      <Languages size={15} strokeWidth={1.8} />
      <span>{active.shortLabel}</span>
    </button>
    {open && <div className="language-popover" role="dialog" aria-label={heading}>
      <div className="language-popover-heading"><span>{heading}</span><small>{active.label}</small></div>
      <div className="language-popover-options">
        {options.map((option) => <button
          key={option.id}
          type="button"
          lang={option.id}
          aria-pressed={option.id === language}
          className={option.id === language ? 'active' : ''}
          onClick={() => {
            setLanguage(option.id);
            setOpen(false);
          }}
        >
          <span>{option.label}</span>
          {option.id === language && <Check size={13} aria-hidden="true" />}
        </button>)}
      </div>
    </div>}
  </div>;
}
