import { useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_TEXT_SIZE, TEXT_SIZES, type TextSize } from './textScale';

export interface TextSizeControlProps {
  readonly size: TextSize;
  readonly onChange: (size: TextSize) => void;
  readonly disabled?: boolean;
}

export function TextSizeControl({ size, onChange, disabled }: TextSizeControlProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="shell-text-size" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus(); }
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" ref={button} className="btn btn-secondary btn-icon shell-icon" aria-label="Text size" aria-expanded={open}
      aria-controls={open ? id : undefined} disabled={disabled} title="Text size (⌘− smaller, ⌘+ or ⌘= larger, ⌘0 default)"
      onClick={() => setOpen(value => !value)}>Aa</button>
    {open && <div className="shell-text-size-menu" id={id} role="group" aria-label="Text size">
      {TEXT_SIZES.map(value => <button type="button" key={value} className={value === size ? 'shell-view shell-view-on' : 'shell-view'}
        aria-pressed={value === size} disabled={disabled} onClick={() => { onChange(value); setOpen(false); button.current?.focus(); }}>
        {value}%{value === DEFAULT_TEXT_SIZE ? ' (default)' : ''}
      </button>)}
    </div>}
  </div>;
}
