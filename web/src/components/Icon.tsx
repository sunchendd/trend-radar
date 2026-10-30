/**
 * 手写 SVG 图标（统一 24×24 viewBox / 1.6 描边，随 currentColor）。
 * 不引图标库：需要的形状就这几个，内联的代价最小。
 */
import type { JSX } from 'react';

export type IconName =
  | 'feed'
  | 'bulb'
  | 'antenna'
  | 'search'
  | 'filter'
  | 'refresh'
  | 'x'
  | 'external'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'copy'
  | 'check'
  | 'alert'
  | 'clock'
  | 'bolt'
  | 'plus'
  | 'keyboard'
  | 'link'
  | 'hash'
  | 'doc'
  | 'trash'
  | 'arrow-right'
  | 'info'
  | 'shield'
  | 'flame'
  | 'sort-desc'
  | 'flask'
  | 'table'
  | 'shield-off'
  | 'circle-slash'
  | 'sun'
  | 'moon';

const PATHS: Record<IconName, string[]> = {
  feed: ['M4 5.5h16', 'M4 12h16', 'M4 18.5h11'],
  bulb: [
    'M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.5.35.8.9.8 1.5v.3h5.2v-.3c0-.6.3-1.15.8-1.5A5.8 5.8 0 0 0 12 3.5Z',
    'M9.8 18.5h4.4',
    'M10.7 21h2.6',
  ],
  antenna: ['M12 12.2h.01', 'M8.4 8.6a5 5 0 0 0 0 7', 'M15.6 8.6a5 5 0 0 1 0 7', 'M5.6 5.8a9 9 0 0 0 0 12.4', 'M18.4 5.8a9 9 0 0 1 0 12.4'],
  search: ['M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z', 'M20 20l-4.2-4.2'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  refresh: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4.2v4.2h-4.2'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  external: ['M14 4h6v6', 'M20 4l-8.4 8.4', 'M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
  'chevron-down': ['M6 9.5l6 6 6-6'],
  'chevron-right': ['M9.5 6l6 6-6 6'],
  'chevron-left': ['M14.5 6l-6 6 6 6'],
  copy: ['M9.5 9.5V6.5A1.5 1.5 0 0 1 11 5h7a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 15h-3', 'M4.5 10.5A1.5 1.5 0 0 1 6 9h7a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 19H6a1.5 1.5 0 0 1-1.5-1.5v-7Z'],
  check: ['M4.5 12.5l5 5L19.5 7'],
  alert: ['M12 3.8 21.4 20H2.6L12 3.8Z', 'M12 9.5v4.4', 'M12 17.2h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.4V12l3.2 2'],
  bolt: ['M13.2 2.5 4.5 14h5.8l-1.4 7.5L18 10h-5.8l1-7.5Z'],
  plus: ['M12 5v14', 'M5 12h14'],
  keyboard: ['M3.5 7h17v10h-17z', 'M7 10.8h.01', 'M11 10.8h.01', 'M15 10.8h.01', 'M8 14.2h8'],
  link: ['M10.4 13.6a3.6 3.6 0 0 0 5.1 0l3-3a3.6 3.6 0 0 0-5.1-5.1l-1 1', 'M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-3 3a3.6 3.6 0 0 0 5.1 5.1l1-1'],
  hash: ['M9.5 4 7.5 20', 'M16.5 4l-2 16', 'M4.8 9h15', 'M3.8 15h15'],
  doc: ['M7 3.5h6.5L18 8v12.5H7V3.5Z', 'M13.5 3.5V8H18', 'M9.8 12.5h5.4', 'M9.8 16h3.6'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10.5 10.5v6', 'M13.5 10.5v6'],
  'arrow-right': ['M4.5 12h13', 'M12.5 6.5l5.5 5.5-5.5 5.5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5.2', 'M12 7.7h.01'],
  shield: ['M12 3.2 5 6v6.2c0 4.2 2.85 7.4 7 8.8 4.15-1.4 7-4.6 7-8.8V6l-7-2.8Z', 'M9.2 12.1l2 2 3.6-3.9'],
  flame: ['M12 20.8c3.4 0 5.8-2.2 5.8-5.3 0-4.3-5.8-12.3-5.8-12.3S6.2 11.2 6.2 15.5c0 3.1 2.4 5.3 5.8 5.3Z', 'M12 17.6c1.2 0 2-.8 2-1.9 0-1.6-2-4.3-2-4.3s-2 2.7-2 4.3c0 1.1.8 1.9 2 1.9Z'],
  'sort-desc': ['M7 4.5v15', 'M4 16.5l3 3 3-3', 'M13 7h6', 'M13 12h4.5', 'M13 17h3'],
  flask: ['M10 3.5h4', 'M11 3.5v5.2L5.9 18a2 2 0 0 0 1.7 3h8.8a2 2 0 0 0 1.7-3L13 8.7V3.5', 'M7.6 14h8.8'],
  table: ['M3.5 5.5h17v13h-17z', 'M3.5 10h17', 'M9.5 10v8.5'],
  'shield-off': ['M12 3.2 5 6v6.2c0 4.2 2.85 7.4 7 8.8 4.15-1.4 7-4.6 7-8.8V6l-7-2.8Z', 'M9.5 9.5l5 5', 'M14.5 9.5l-5 5'],
  sun: [
    'M12 16.4a4.4 4.4 0 1 0 0-8.8 4.4 4.4 0 0 0 0 8.8Z',
    'M12 2.6v2.2',
    'M12 19.2v2.2',
    'M4.4 4.4l1.6 1.6',
    'M18 18l1.6 1.6',
    'M2.6 12h2.2',
    'M19.2 12h2.2',
    'M4.4 19.6L6 18',
    'M18 6l1.6-1.6',
  ],
  moon: ['M20.5 14.4A8.6 8.6 0 0 1 9.6 3.5a8.6 8.6 0 1 0 10.9 10.9Z'],
  'circle-slash': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M6 18 18 6'],
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: boolean;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.6 }: IconProps): JSX.Element {
  const paths = PATHS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** 品牌标：雷达扫描圈 */
export function BrandMark({ size = 26 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="4.6" stroke="var(--color-accent)" strokeWidth="1.3" opacity="0.45" />
      <circle cx="16" cy="16" r="9.4" stroke="var(--color-accent)" strokeWidth="1.3" opacity="0.3" />
      <circle cx="16" cy="16" r="13.6" stroke="var(--color-accent)" strokeWidth="1.1" opacity="0.16" strokeDasharray="2 4" />
      <path d="M16 16 L25.4 6.6" stroke="var(--color-accent)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 16 L16 2.6" stroke="var(--color-accent)" strokeWidth="1.2" opacity="0.25" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.2" fill="var(--color-accent)" />
      <circle cx="25.4" cy="6.6" r="2" fill="var(--color-accent-soft)" />
    </svg>
  );
}
