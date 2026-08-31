import { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { UI_THEMES, type UiTheme } from '../lib/uiTheme';

type ThemePickerProps = {
  value: UiTheme;
  onChange: (theme: UiTheme) => void;
};

/** Compact, shared theme control used by both the task desk and runtime shell. */
export function ThemePicker({ value, onChange }: ThemePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const active = UI_THEMES.find((theme) => theme.id === value) ?? UI_THEMES[0]!;

  return (
    <div ref={rootRef} className="theme-picker-control">
      <button
        type="button"
        className="theme-trigger"
        title={`主题：${active.label}`}
        aria-label={`选择主题，当前为${active.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Palette size={15} strokeWidth={1.8} />
        <span className="theme-trigger-dot" style={{ background: active.swatches[1] }} aria-hidden="true" />
      </button>
      {open && (
        <div className="theme-popover" role="dialog" aria-label="选择界面主题">
          <div className="theme-popover-heading">
            <span>界面主题</span>
            <small>{active.label}</small>
          </div>
          <div className="theme-popover-grid">
            {UI_THEMES.map((theme) => {
              const selected = theme.id === value;
              return (
                <button
                  key={theme.id}
                  type="button"
                  data-theme-id={theme.id}
                  className={`theme-option${selected ? ' active' : ''}`}
                  aria-pressed={selected}
                  onClick={() => {
                    onChange(theme.id);
                    setOpen(false);
                  }}
                >
                  <span className="theme-option-swatch" aria-hidden="true">
                    {theme.swatches.map((swatch) => <i key={swatch} style={{ background: swatch }} />)}
                  </span>
                  <span className="theme-option-copy">
                    <strong>{theme.label}</strong>
                    <small>{theme.description}</small>
                  </span>
                  <span className="theme-option-check" aria-hidden="true">{selected && <Check size={11} strokeWidth={2.4} />}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
