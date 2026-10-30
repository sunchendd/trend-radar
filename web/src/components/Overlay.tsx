/**
 * Drawer（右侧抽屉）与 Modal（居中浮层）的共用行为：
 * Esc 关闭、点遮罩关闭、打开时锁滚动、关闭后把焦点还给触发者。
 */
import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { IconButton } from './primitives';

function useOverlayBehavior(open: boolean, onClose: () => void): {
  panelRef: RefObject<HTMLDivElement | null>;
} {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);

    // 焦点移入面板，便于键盘滚动/关闭
    const t = setTimeout(() => {
      panelRef.current?.focus({ preventScroll: true });
    }, 30);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
      restoreRef.current?.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  return { panelRef };
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** 桌面端宽度（px） */
  width?: number;
  header?: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, label, children, width = 560, header, footer }: DrawerProps): JSX.Element | null {
  const { panelRef } = useOverlayBehavior(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60]" role="presentation">
      <div
        className="animate-fade absolute inset-0 bg-black/62 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="animate-slide-right absolute inset-y-0 right-0 flex w-full flex-col border-l border-line-strong bg-surface shadow-[var(--shadow-pop)] outline-none sm:w-[var(--drawer-w)] sm:max-w-full"
        style={{ ['--drawer-w' as string]: `${width}px` }}
      >
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">{header}</div>
          <IconButton icon="x" label="关闭（Esc）" onClick={onClose} />
        </div>
        <div className="scroll-area min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="border-t border-line bg-surface px-4 py-2.5">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  label,
  children,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  width?: number;
}): JSX.Element | null {
  const { panelRef } = useOverlayBehavior(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="presentation">
      <div className="animate-fade absolute inset-0 bg-black/65 backdrop-blur-[3px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="animate-rise relative max-h-[86vh] w-full overflow-hidden rounded-card border border-line-strong bg-surface shadow-[var(--shadow-pop)] outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-[13px] font-medium text-ink">{label}</div>
          <IconButton icon="x" label="关闭（Esc）" onClick={onClose} />
        </div>
        <div className="scroll-area max-h-[calc(86vh-49px)] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/** 快捷键帮助浮层 */
export function HelpOverlay({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const rows: { keys: string[]; desc: string }[] = [
    { keys: ['/'], desc: '聚焦搜索框' },
    { keys: ['g'], desc: '切换「加载更多 / 分页」模式' },
    { keys: ['f'], desc: '展开或收起筛选器' },
    { keys: ['c'], desc: '一键采集（论文 / 新闻页）' },
    { keys: ['1', '2', '3', '4', '5'], desc: '切换 论文 / 新闻 / 选题 / 巡检 / 信源' },
    { keys: [','], desc: '打开设置' },
    { keys: ['Esc'], desc: '关闭抽屉、浮层或退出输入' },
    { keys: ['?'], desc: '打开这份快捷键帮助' },
  ];
  return (
    <Modal open={open} onClose={onClose} label="快捷键" width={460}>
      <div className="p-4">
        <p className="mb-3 text-[11.5px] text-ink-3">
          在输入框里打字时快捷键不生效；带 <Icon name="keyboard" size={11} className="inline align-[-1px]" /> 的键位也支持中文输入法下的英文态。
        </p>
        <div className="divide-y divide-line">
          {rows.map((r) => (
            <div key={r.desc} className="flex items-center justify-between gap-3 py-2">
              <span className="text-[12.5px] text-ink-2">{r.desc}</span>
              <span className="flex items-center gap-1">
                {r.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
