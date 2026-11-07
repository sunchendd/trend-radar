/**
 * 设置页的「自动中文翻译」区块（t18）：开关 + 每日上限 + 「翻译今日」手动触发。
 *
 * 刻意自成一体（不进 SettingsPage 的表单保存流）：三项配置改动即时保存，
 * 不和「采集调度」等主表单共用一个「保存更改」按钮——翻译是独立子系统，
 * 混进主表单会让一次保存携带无关 diff。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AppSettings, TranslationStatus, TranslationRunResult } from '../lib/types';
import { getTranslationStatus, putSettings, runTranslation } from '../lib/api';
import { friendlyError } from '../lib/api';
import { Pill, SectionHead, Spinner, Toggle } from './primitives';
import { useToastFns } from './Toast';

export function TranslationSection({
  settings,
  onSaved,
}: {
  settings: AppSettings;
  /** 保存后让父页面重载生效设置 */
  onSaved: () => void;
}): JSX.Element {
  const toast = useToastFns();
  const [enabled, setEnabled] = useState(settings.translation.enabled);
  const [dailyLimit, setDailyLimit] = useState(String(settings.translation.dailyLimit));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<TranslationStatus | null>(null);
  const inflightRef = useRef(false);

  // 外部重载设置后同步本地表单（以 settings 引用变化为准）
  useEffect(() => {
    setEnabled(settings.translation.enabled);
    setDailyLimit(String(settings.translation.dailyLimit));
  }, [settings]);

  const refreshStatus = useCallback(async () => {
    if (inflightRef.current) return;
    try {
      setStatus(await getTranslationStatus());
    } catch {
      // 状态拿不到就算了（离线/demode），不打断设置页
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const persist = useCallback(
    async (next: { enabled: boolean; dailyLimit: number }) => {
      setSaving(true);
      try {
        await putSettings({ translation: next });
        onSaved();
        toast.ok('翻译设置已保存');
        void refreshStatus();
      } catch (error) {
        const f = friendlyError(error);
        toast.error(`保存失败：${f.title}`, f.hint);
      } finally {
        setSaving(false);
      }
    },
    [onSaved, refreshStatus, toast],
  );

  const onToggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      void persist({ enabled: next, dailyLimit: Number(dailyLimit) || settings.translation.dailyLimit });
    },
    [dailyLimit, persist, settings.translation.dailyLimit],
  );

  const onLimitBlur = useCallback(() => {
    const parsed = Number(dailyLimit.trim());
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed) || parsed === settings.translation.dailyLimit) {
      setDailyLimit(String(settings.translation.dailyLimit));
      return;
    }
    setDailyLimit(String(parsed));
    void persist({ enabled, dailyLimit: parsed });
  }, [dailyLimit, enabled, persist, settings.translation.dailyLimit]);

  const onRun = useCallback(async () => {
    setRunning(true);
    try {
      const result: TranslationRunResult = await runTranslation();
      if (result.degraded) {
        toast.warn('LLM 未配置', '在下方「LLM」区块填好 baseUrl 与 API Key 后再试。');
      } else if (result.capReached && result.translated === 0) {
        toast.warn('已达每日上限', `今天已翻译 ${result.translated}/${settings.translation.dailyLimit} 条，明天再继续。`);
      } else {
        toast.ok(
          `翻译完成 ${result.translated} 条`,
          `跳过中文 ${result.skippedCjk} · 失败 ${result.failed}${result.capReached ? ' · 已到每日上限' : ''}`,
        );
      }
      void refreshStatus();
      onSaved();
    } catch (error) {
      const f = friendlyError(error);
      toast.error(`触发失败：${f.title}`, f.hint);
    } finally {
      setRunning(false);
    }
  }, [onSaved, refreshStatus, settings.translation.dailyLimit, toast]);

  const llmReady = settings.llm.hasApiKey && settings.llm.baseUrl.trim() !== '';

  return (
    <section className="card p-3.5">
      <SectionHead
        title="自动中文翻译（论文 / 新闻）"
        hint="采集后后台翻译标题与摘要；复用上方 LLM 配置"
        right={
          <Pill
            color={!settings.translation.enabled ? 'var(--color-ink-3)' : llmReady ? 'var(--color-accent)' : 'var(--color-warn)'}
            bg="color-mix(in oklab, var(--color-accent) 8%, transparent)"
            border="color-mix(in oklab, var(--color-accent) 26%, transparent)"
          >
            {!settings.translation.enabled ? '已关闭' : llmReady ? '可用' : 'LLM 未配置'}
          </Pill>
        }
      />
      <div className="mt-2 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-ink">采集后自动翻译</p>
            <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-3">
              关闭后不自动翻译，「翻译今日」仍可手动触发；中文原文条目自动跳过
            </p>
          </div>
          <Toggle checked={enabled} onChange={onToggle} disabled={saving} label="自动翻译开关" />
        </div>

        <div className="flex items-center justify-between gap-3">
          <label className="min-w-0 text-[12px] font-medium text-ink" htmlFor="tr-daily-limit">
            每日上限（条）
          </label>
          <input
            id="tr-daily-limit"
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
            onBlur={onLimitBlur}
            inputMode="numeric"
            spellCheck={false}
            aria-label="每日翻译上限"
            className="input num h-8 w-[110px] text-right text-[12px]"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-tile border border-line bg-sunken px-3 py-2">
          <div className="text-[10.5px] leading-relaxed text-ink-3">
            {status ? (
              <>
                今日已翻 <span className="num text-ink-2">{status.translatedToday}</span> / {status.dailyLimit} 条 ·
                待翻 <span className="num text-ink-2">{status.pending}</span> 条
                {status.lastError ? <span className="ml-1 text-warn">· 上次错误：{status.lastError.slice(0, 60)}</span> : null}
              </>
            ) : (
              '状态加载中…'
            )}
          </div>
          <button type="button" className="btn h-7 text-[11px]" onClick={() => void onRun()} disabled={running}>
            {running ? <Spinner size={12} /> : null}
            {running ? '翻译中…' : '翻译今日'}
          </button>
        </div>

        {!llmReady ? (
          <p className="text-[10.5px] leading-relaxed text-ink-3">
            LLM 未配置：翻译功能处于降级状态（不会报错，也不会消耗额度）。在上方「LLM」区块填好
            baseUrl 与 API Key 即自动恢复。
          </p>
        ) : null}
      </div>
    </section>
  );
}
