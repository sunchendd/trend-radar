/**
 * 加载骨架：形状要和真内容一致，否则会出现布局跳动。
 */
import type { JSX } from 'react';

export function Skeleton({
  w = '100%',
  h = 12,
  radius = 5,
  className = '',
}: {
  w?: number | string;
  h?: number | string;
  radius?: number;
  className?: string;
}): JSX.Element {
  return <div className={`skeleton ${className}`} style={{ width: w, height: h, borderRadius: radius }} />;
}

export function ItemCardSkeleton(): JSX.Element {
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Skeleton w={64} h={15} radius={4} />
            <Skeleton w={40} h={15} radius={4} />
            <Skeleton w={52} h={11} />
          </div>
          <Skeleton w="92%" h={16} className="mt-2.5" />
          <Skeleton w="68%" h={16} className="mt-1.5" />
          <div className="mt-3 flex gap-1.5">
            <Skeleton w={54} h={18} radius={5} />
            <Skeleton w={72} h={18} radius={5} />
            <Skeleton w={48} h={18} radius={5} />
          </div>
        </div>
        <Skeleton w={44} h={44} radius={22} />
      </div>
    </div>
  );
}

export function StatSkeleton(): JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card px-3.5 py-3">
          <Skeleton w={68} h={10} />
          <div className="mt-2.5 flex items-end justify-between">
            <Skeleton w={54} h={24} />
            <Skeleton w={40} h={20} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ListRowSkeleton(): JSX.Element {
  return (
    <div className="border-b border-line px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Skeleton w={7} h={7} radius={99} />
        <Skeleton w="60%" h={12} />
      </div>
      <Skeleton w="40%" h={10} className="mt-2" />
    </div>
  );
}

export function IdeaDetailSkeleton(): JSX.Element {
  return (
    <div className="p-5">
      <Skeleton w={96} h={10} />
      <Skeleton w="80%" h={22} className="mt-3" />
      <Skeleton w="52%" h={22} className="mt-2" />
      <div className="mt-5 space-y-2.5">
        <Skeleton w="100%" h={12} />
        <Skeleton w="96%" h={12} />
        <Skeleton w="88%" h={12} />
        <Skeleton w="70%" h={12} />
      </div>
      <div className="mt-6 space-y-2.5">
        <Skeleton w="100%" h={12} />
        <Skeleton w="92%" h={12} />
        <Skeleton w="64%" h={12} />
      </div>
    </div>
  );
}

/** 生成选题时的"思考中"骨架：带阶段文案 */
export function GeneratingSkeleton(): JSX.Element {
  return (
    <div className="card animate-fade p-4">
      <div className="flex items-center gap-2">
        <span className="glow-dot" />
        <span className="text-[12px] font-medium text-ink">正在拆解技术特征…</span>
        <span className="ml-auto text-[10.5px] text-ink-3">LLM 生成中，通常 20–60s</span>
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton w="86%" h={14} />
        <Skeleton w="70%" h={14} />
        <Skeleton w="94%" h={11} />
        <Skeleton w="62%" h={11} />
        <div className="flex gap-1.5 pt-1">
          <Skeleton w={52} h={18} radius={5} />
          <Skeleton w={64} h={18} radius={5} />
          <Skeleton w={44} h={18} radius={5} />
        </div>
      </div>
    </div>
  );
}
