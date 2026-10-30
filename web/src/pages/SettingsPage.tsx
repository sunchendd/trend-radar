/**
 * 设置页：采集调度 / KPI 口径 / LLM / 查新 CLI。
 *
 * 原则：
 * 1. **只提交改过的字段**（patch 语义）——尤其 API Key：留空 = 不改，
 *    后端也永不回传明文，页面只显示「已配置 / 未配置」；
 * 2. 所有校验都在本地先做一遍（时刻格式、范围、midScore ≤ highScore），
 *    错误就地标注，不让用户提交后才知道；
 * 3. 接口没就绪（404 / 后端没起）时**不假装成功**：显式挂提示、禁用保存。
 */
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { fieldErrorsOf, friendlyError, putSettings, toApiError, type ApiError } from '../lib/api';
import { absTime, relTime } from '../lib/format';
import { primeSettings, useAppSettings, useTicker } from '../lib/hooks';
import type { AppSettings, AppSettingsPatch, RefreshMode } from '../lib/types';
import { Icon } from '../components/Icon';
import { NoticeBar } from '../components/States';
import { useToastFns } from '../components/Toast';
import { Pill, SectionHead, Spinner, Toggle } from '../components/primitives';

interface FormState {
  dailyRefreshEnabled: boolean;
  dailyRefreshAt: string;
  collectMinutes: string;
  limitPerSource: string;
  minKeepScore: string;
  ttlDays: string;
  highScore: string;
  midScore: string;
  llmBaseUrl: string;
  llmModel: string;
  /** 空 = 不修改；永不回显明文 */
  apiKey: string;
  noveltyCommand: string;
}

const EMPTY_FORM: FormState = {
  dailyRefreshEnabled: true,
  dailyRefreshAt: '06:30',
  collectMinutes: '360',
  limitPerSource: '40',
  minKeepScore: '0',
  ttlDays: '180',
  highScore: '70',
  midScore: '50',
  llmBaseUrl: '',
  llmModel: '',
  apiKey: '',
  noveltyCommand: '',
};

function toForm(s: AppSettings): FormState {
  return {
    dailyRefreshEnabled: s.dailyRefreshEnabled,
    dailyRefreshAt: s.dailyRefreshAt,
    collectMinutes: String(s.collectMinutes),
    limitPerSource: String(s.limitPerSource),
    minKeepScore: String(s.minKeepScore),
    ttlDays: String(s.ttlDays),
    highScore: String(s.highScore),
    midScore: String(s.midScore),
    llmBaseUrl: s.llm.baseUrl,
    llmModel: s.llm.model,
    apiKey: '',
    noveltyCommand: s.novelty.command,
  };
}

type FieldKey = keyof FormState;
type Errors = Partial<Record<FieldKey, string>>;

/** 后端 validation_error 里能落回表单的字段名（其余一律走整表提示） */
const KNOWN_FIELDS: readonly FieldKey[] = [
  'dailyRefreshAt',
  'collectMinutes',
  'limitPerSource',
  'minKeepScore',
  'ttlDays',
  'highScore',
  'midScore',
  'llmBaseUrl',
  'llmModel',
  'noveltyCommand',
];

const INT_RANGES: { key: FieldKey; label: string; min: number; max: number; hint: string }[] = [
  { key: 'collectMinutes', label: '间隔采集', min: 0, max: 1440, hint: '0 = 不按间隔采集（分钟）' },
  { key: 'limitPerSource', label: '每源抓取上限', min: 1, max: 500, hint: '每次每源最多取多少条' },
  { key: 'minKeepScore', label: '最低保留分', min: 0, max: 100, hint: '低于此分不入库' },
  { key: 'ttlDays', label: '保留天数', min: 1, max: 3650, hint: '超过则清理' },
];

function validate(f: FormState): Errors {
  const errors: Errors = {};
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.dailyRefreshAt)) {
    errors.dailyRefreshAt = '格式应为 HH:mm（24 小时制）';
  }
  for (const r of INT_RANGES) {
    const raw = f[r.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      errors[r.key] = `${r.label}不能为空`;
      continue;
    }
    if (!/^\d+$/.test(value)) {
      errors[r.key] = `${r.label}必须是整数`;
      continue;
    }
    const n = Number(value);
    if (n < r.min || n > r.max) errors[r.key] = `${r.label}应在 ${r.min}–${r.max} 之间`;
  }
  for (const key of ['highScore', 'midScore'] as const) {
    const raw = f[key].trim();
    const label = key === 'highScore' ? '高分线' : '待判线';
    if (raw === '') errors[key] = `${label}不能为空`;
    else if (!/^\d+$/.test(raw)) errors[key] = `${label}必须是整数`;
    else if (Number(raw) > 100) errors[key] = `${label}应在 0–100 之间`;
  }
  const hi = Number(f.highScore);
  const mid = Number(f.midScore);
  if (!errors.highScore && !errors.midScore && mid > hi) {
    errors.midScore = '待判线不能高于高分线';
  }
  if (f.llmBaseUrl.trim() !== '' && !/^https?:\/\//i.test(f.llmBaseUrl.trim())) {
    errors.llmBaseUrl = 'baseUrl 应以 http:// 或 https:// 开头';
  }
  return errors;
}

function buildPatch(f: FormState, base: AppSettings): AppSettingsPatch {
  const patch: AppSettingsPatch = {};
  if (f.dailyRefreshEnabled !== base.dailyRefreshEnabled) patch.dailyRefreshEnabled = f.dailyRefreshEnabled;
  if (f.dailyRefreshAt !== base.dailyRefreshAt) patch.dailyRefreshAt = f.dailyRefreshAt;
  const nums: { key: FieldKey; apiKey: keyof AppSettingsPatch }[] = [
    { key: 'collectMinutes', apiKey: 'collectMinutes' },
    { key: 'limitPerSource', apiKey: 'limitPerSource' },
    { key: 'minKeepScore', apiKey: 'minKeepScore' },
    { key: 'ttlDays', apiKey: 'ttlDays' },
    { key: 'highScore', apiKey: 'highScore' },
    { key: 'midScore', apiKey: 'midScore' },
  ];
  const current = toForm(base);
  for (const n of nums) {
    const next = Number(f[n.key]);
    const prev = Number(current[n.key]);
    if (Number.isFinite(next) && next !== prev) {
      // 逐字段赋值，保持类型精确（不整体 spread，避免把非数字塞进去）
      if (n.apiKey === 'collectMinutes') patch.collectMinutes = next;
      else if (n.apiKey === 'limitPerSource') patch.limitPerSource = next;
      else if (n.apiKey === 'minKeepScore') patch.minKeepScore = next;
      else if (n.apiKey === 'ttlDays') patch.ttlDays = next;
      else if (n.apiKey === 'highScore') patch.highScore = next;
      else if (n.apiKey === 'midScore') patch.midScore = next;
    }
  }
  const llm: { baseUrl?: string; model?: string; apiKey?: string } = {};
  if (f.llmBaseUrl.trim() !== base.llm.baseUrl) llm.baseUrl = f.llmBaseUrl.trim();
  if (f.llmModel.trim() !== base.llm.model) llm.model = f.llmModel.trim();
  if (f.apiKey.trim() !== '') llm.apiKey = f.apiKey.trim();
  if (Object.keys(llm).length > 0) patch.llm = llm;
  if (f.noveltyCommand.trim() !== base.novelty.command) patch.novelty = { command: f.noveltyCommand.trim() };
  return patch;
}

/**
 * 顶部那行「采集调度」的文案。
 *
 * 三态完全按后端的 `refreshMode` 分支（含「每日时刻非法 → 后端已回落到
 * interval/off」这种情况），前端不再自己用 dailyRefreshEnabled/collectMinutes 推导。
 */
export function scheduleText(s: AppSettings, now: number): { label: string; detail: string } {
  const mode: RefreshMode = s.refreshMode;
  if (mode === 'daily') {
    return {
      label: `下次定时刷新 ${untilText(s.nextRefreshAt, now)}`,
      detail: s.nextRefreshAt
        ? `每天 ${s.dailyRefreshAt} 抓一轮 · 下次 ${absTime(s.nextRefreshAt)}（${untilText(s.nextRefreshAt, now)}）`
        : `每天 ${s.dailyRefreshAt} 抓一轮 · 后端暂未给出下次时间`,
    };
  }
  if (mode === 'interval') {
    return {
      label: `间隔采集：每 ${s.collectMinutes} 分钟`,
      detail: s.nextRefreshAt
        ? `每 ${s.collectMinutes} 分钟抓一轮 · 下次 ${absTime(s.nextRefreshAt)}（${untilText(s.nextRefreshAt, now)}）`
        : `每 ${s.collectMinutes} 分钟抓一轮 · 后端暂未给出下次时间`,
    };
  }
  return { label: '自动采集已关闭', detail: '只能手动点「一键采集」，或由外部定时任务触发' };
}

/** 未来时刻的相对描述（relTime 只处理过去） */
function untilText(iso: string | null, now: number): string {
  if (!iso) return '未启用';
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return '—';
  if (diff <= 0) return '即将触发';
  const min = Math.round(diff / 60_000);
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟后`;
  const hour = Math.floor(min / 60);
  const rest = min % 60;
  if (hour < 24) return rest > 0 ? `${hour} 小时 ${rest} 分后` : `${hour} 小时后`;
  return `${Math.floor(hour / 24)} 天 ${hour % 24} 小时后`;
}

export function SettingsPage({
  liveNonce,
  onBack,
  onSaved,
}: {
  liveNonce: number;
  onBack: () => void;
  onSaved: () => void;
}): JSX.Element {
  const toast = useToastFns();
  const settings = useAppSettings(liveNonce);
  const tick = useTicker(15_000);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [base, setBase] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  /** 后端 400 validation_error 回填的字段级错误（优先级高于本地校验） */
  const [serverErrors, setServerErrors] = useState<Errors>({});

  // 首次拿到 / 重新加载后同步表单（用户正在改的输入不会被覆盖：只在 base 变化时整体重置）
  useEffect(() => {
    if (!settings.data) return;
    setBase(settings.data);
    setForm(toForm(settings.data));
  }, [settings.data]);

  const errors = useMemo(() => ({ ...validate(form), ...serverErrors }), [form, serverErrors]);
  const hasErrors = Object.keys(errors).length > 0;
  const patch = useMemo(() => (base ? buildPatch(form, base) : {}), [form, base]);
  const dirty = Object.keys(patch).length > 0;
  const endpointMissing =
    settings.error !== null && (settings.error.code === 'not_found' || settings.error.offline);

  const patchField = useCallback(<K extends FieldKey>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // 用户改了某个字段就把它上面的服务端错误清掉
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const onSave = useCallback(async () => {
    if (hasErrors) {
      toast.error('还有字段没填对', Object.values(errors).filter(Boolean).slice(0, 2).join('；'));
      return;
    }
    if (!dirty) {
      toast.info('没有改动', '改几个字段再保存。');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setServerErrors({});
    try {
      const next = await putSettings(patch);
      primeSettings(next);
      setBase(next);
      setForm(toForm(next));
      toast.ok(
        '设置已保存',
        next.nextRefreshAt
          ? `下次定时刷新：${absTime(next.nextRefreshAt)}（${untilText(next.nextRefreshAt, Date.now())}）`
          : '已关闭每日定时刷新，且间隔采集为 ' + next.collectMinutes + ' 分钟。',
      );
      onSaved();
    } catch (err) {
      const apiErr = toApiError(err);
      setSaveError(apiErr);
      // 400 validation_error：把后端说的话落到具体输入框下面，而不是只弹一个 toast
      if (apiErr.status === 400 || apiErr.status === 422) {
        const fields = fieldErrorsOf(apiErr.detail, KNOWN_FIELDS) as Errors;
        if (Object.keys(fields).length > 0) {
          setServerErrors(fields);
          toast.error('有字段没通过后端校验', Object.values(fields).filter(Boolean).slice(0, 2).join('；'));
          return;
        }
      }
      const f = friendlyError(apiErr);
      toast.error(f.title, f.hint);
    } finally {
      setSaving(false);
    }
  }, [dirty, errors, hasErrors, onSaved, patch, toast]);

  const now = Date.now() + tick * 0; // tick 只用于触发重渲染，时间取当前
  const data = settings.data;

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-3.5 px-3 py-3.5 md:px-5 md:py-4">
      {/* 顶部：下次刷新 / 上次保存 / 保存 */}
      <section className="card p-3.5">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name="clock" size={14} className="text-accent" />
              <span className="text-[12.5px] font-medium text-ink">运行状态</span>
              {data ? (
                <Pill
                  color={
                    data.refreshMode === 'off'
                      ? 'var(--color-ink-3)'
                      : data.refreshMode === 'interval'
                        ? 'var(--color-info)'
                        : 'var(--color-accent)'
                  }
                  bg="color-mix(in oklab, var(--color-accent) 10%, transparent)"
                  border="color-mix(in oklab, var(--color-accent) 30%, transparent)"
                  title={`refreshMode = ${data.refreshMode}`}
                >
                  {scheduleText(data, now).label}
                </Pill>
              ) : null}
            </div>
            <div className="mt-1.5 space-y-1 text-[11px] text-ink-3">
              <div>
                调度：
                <span className="text-ink-2">{data ? scheduleText(data, now).detail : '—'}</span>
              </div>
              <div>
                上次保存：{' '}
                <span className="text-ink-2">
                  {data?.updatedAt ? `${absTime(data.updatedAt)}（${relTime(data.updatedAt)}）` : '从未保存（当前为默认值）'}
                </span>
              </div>
            </div>
            {data ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
                <span className="num">当前口径 ≥{data.highScore} 高分 · {data.midScore}–{data.highScore} 待判</span>
                <span className="text-ink-3/50">·</span>
                <span>LLM {data.llm.hasApiKey ? '已配置' : '未配置'}</span>
                <span className="text-ink-3/50">·</span>
                <span>查新 CLI {data.novelty.hasCommand ? '可用（路径存在）' : '路径不存在'}</span>
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button type="button" className="btn btn-ghost h-8" onClick={onBack} title="回到论文页">
              <Icon name="chevron-left" size={13} />
              返回
            </button>
            <button
              type="button"
              className="btn h-8"
              onClick={() => settings.refresh()}
              disabled={settings.loading}
              title="重新读取后端设置"
            >
              {settings.loading ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}
              重载
            </button>
            <button
              type="button"
              className="btn btn-accent h-8"
              onClick={() => void onSave()}
              disabled={saving || hasErrors || !dirty || endpointMissing || data === null}
            >
              {saving ? <Spinner size={12} /> : <Icon name="check" size={13} />}
              {saving ? '保存中…' : dirty ? '保存更改' : '已是最新'}
            </button>
          </div>
        </div>

        {endpointMissing ? (
          <div className="mt-2.5">
            <NoticeBar tone="warn">
              后端还没有 <code className="num">/api/settings</code>（
              {settings.error?.offline ? '连不上后端' : `HTTP ${settings.error?.status ?? 404}`}）：
              下面是默认值，<strong>保存会失败</strong>。后端就绪后点「重载」。
            </NoticeBar>
          </div>
        ) : null}
        {saveError && !endpointMissing ? (
          <div className="mt-2.5">
            <NoticeBar tone="warn">
              保存失败：{friendlyError(saveError).title}
              {friendlyError(saveError).hint ? ` — ${friendlyError(saveError).hint}` : ''}
            </NoticeBar>
          </div>
        ) : null}
        {hasErrors ? (
          <div className="mt-2.5">
            <NoticeBar tone="warn">{Object.values(errors).filter(Boolean).slice(0, 3).join('；')}</NoticeBar>
          </div>
        ) : null}
      </section>

      {data === null && settings.loading ? (
        <section className="card flex items-center gap-2 p-4 text-[12px] text-ink-3">
          <Spinner size={13} /> 正在读取设置…
        </section>
      ) : (
        <>
          {/* 采集调度 */}
          <section className="card p-3.5">
            <SectionHead title="采集调度" hint="决定后台多久抓一次、每次抓多少、留多久" />
            <div className="mt-2 space-y-2.5">
              <Row
                label="每日定时刷新"
                hint="每天固定时刻抓一轮；关掉则按「间隔采集」跑"
                error={errors.dailyRefreshAt}
              >
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={form.dailyRefreshEnabled}
                    onChange={(v) => patchField('dailyRefreshEnabled', v)}
                    label="每日定时刷新"
                  />
                  <input
                    type="time"
                    value={form.dailyRefreshAt}
                    onChange={(e) => patchField('dailyRefreshAt', e.target.value)}
                    disabled={!form.dailyRefreshEnabled}
                    aria-label="每日定时刷新时刻"
                    className="input num h-8 w-[112px] text-[12px] disabled:opacity-45"
                  />
                </div>
              </Row>

              {INT_RANGES.map((r) => (
                <Row key={r.key} label={r.label} hint={r.hint} error={errors[r.key]}>
                  <div className="flex items-center gap-1.5">
                    <input
                      value={String(form[r.key])}
                      onChange={(e) => patchField(r.key, e.target.value.replace(/[^\d]/g, ''))}
                      inputMode="numeric"
                      aria-label={r.label}
                      className="input num h-8 w-[92px] text-right text-[12px]"
                    />
                    <span className="w-[52px] text-[10.5px] text-ink-3">
                      {r.key === 'collectMinutes' ? '分钟' : r.key === 'ttlDays' ? '天' : r.key === 'limitPerSource' ? '条' : '分'}
                    </span>
                  </div>
                </Row>
              ))}
            </div>
          </section>

          {/* KPI 口径 */}
          <section className="card p-3.5">
            <SectionHead
              title="KPI 阈值"
              hint="论文页 / 新闻页顶部的「高分 / 待判」按这套口径统计"
              right={
                <span className="num text-[10px] text-ink-3">
                  ≥{form.highScore || '—'} 高分 · {form.midScore || '—'}–{form.highScore || '—'} 待判
                </span>
              }
            />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <LabeledNumber
                label="高分线"
                value={form.highScore}
                onChange={(v) => patchField('highScore', v)}
                error={errors.highScore}
                suffix="分"
              />
              <LabeledNumber
                label="待判线"
                value={form.midScore}
                onChange={(v) => patchField('midScore', v)}
                error={errors.midScore}
                suffix="分"
              />
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
              打分刻度会随抓取策略变化——阈值长期不调就可能出现「高分永远是 0」，那时把它调到当前分布的上沿更有用。
            </p>
          </section>

          {/* LLM */}
          <section className="card p-3.5">
            <SectionHead
              title="LLM（选题生成）"
              hint="OpenAI 兼容接口；key 只写不回显"
              right={
                <Pill
                  color={data?.llm.hasApiKey ? 'var(--color-accent)' : 'var(--color-warn)'}
                  bg={data?.llm.hasApiKey ? 'color-mix(in oklab, var(--color-accent) 10%, transparent)' : 'color-mix(in oklab, var(--color-warn) 10%, transparent)'}
                  border={data?.llm.hasApiKey ? 'color-mix(in oklab, var(--color-accent) 32%, transparent)' : 'color-mix(in oklab, var(--color-warn) 34%, transparent)'}
                >
                  API Key {data?.llm.hasApiKey ? '已配置' : '未配置'}
                </Pill>
              }
            />
            <div className="mt-2 space-y-2.5">
              <Row label="baseUrl" hint="如 https://api.deepseek.com/v1" error={errors.llmBaseUrl}>
                <input
                  value={form.llmBaseUrl}
                  onChange={(e) => patchField('llmBaseUrl', e.target.value)}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  aria-label="LLM baseUrl"
                  className="input num h-8 w-full text-[12px] sm:w-[300px]"
                />
              </Row>
              <Row label="model" hint="如 deepseek-chat">
                <input
                  value={form.llmModel}
                  onChange={(e) => patchField('llmModel', e.target.value)}
                  placeholder="model id"
                  spellCheck={false}
                  aria-label="LLM model"
                  className="input num h-8 w-full text-[12px] sm:w-[220px]"
                />
              </Row>
              <Row label="API Key" hint={data?.llm.hasApiKey ? '已配置；留空表示不修改' : '还没有配置，填一个再保存'}>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => patchField('apiKey', e.target.value)}
                  placeholder={data?.llm.hasApiKey ? '••••••••（留空不改）' : 'sk-…'}
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-label="LLM API Key"
                  className="input num h-8 w-full text-[12px] sm:w-[260px]"
                />
              </Row>
            </div>
          </section>

          {/* 查新 */}
          <section className="card p-3.5">
            <SectionHead
              title="查新（智慧芽 CLI）"
              hint="自动查新用；没配也可以手工登记命中数"
              right={
                <Pill
                  color={data?.novelty.hasCommand ? 'var(--color-accent)' : 'var(--color-ink-3)'}
                  bg="color-mix(in oklab, var(--color-accent) 8%, transparent)"
                  border="color-mix(in oklab, var(--color-accent) 26%, transparent)"
                >
                  {data?.novelty.hasCommand ? 'CLI 可用' : '路径不存在'}
                </Pill>
              }
            />
            <div className="mt-2">
              <Row
                label="CLI 路径 / 命令"
                hint={
                  data?.novelty.hasCommand
                    ? '路径存在，可直接自动查新'
                    : '路径不存在或不可执行：自动查新会失败，仍可手工登记命中数'
                }
                error={errors.noveltyCommand}
              >
                <input
                  value={form.noveltyCommand}
                  onChange={(e) => patchField('noveltyCommand', e.target.value)}
                  placeholder="zhihuiya"
                  spellCheck={false}
                  aria-label="查新 CLI 命令"
                  className="input num h-8 w-full text-[12px] sm:w-[260px]"
                />
              </Row>
            </div>
          </section>

          <p className="pb-2 text-[10.5px] leading-relaxed text-ink-3">
            信源的启停 / 权重 / 备注仍在「信源」页；这里只管全局策略。
            {dirty ? <span className="ml-1 text-warn">有未保存的改动</span> : null}
          </p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 小结构

function Row({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <div className="text-[12px] text-ink-2">{label}</div>
        {hint ? <div className="text-[10px] text-ink-3">{hint}</div> : null}
        {error ? <div className="text-[10px] text-danger">{error}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  onChange,
  error,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  suffix?: string;
}): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-[11px] text-ink-3">{label}</div>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
          inputMode="numeric"
          aria-label={label}
          className="input num h-8 w-full max-w-[160px] text-right text-[12px]"
        />
        {suffix ? <span className="shrink-0 text-[10.5px] text-ink-3">{suffix}</span> : null}
      </div>
      {error ? <div className="mt-1 text-[10px] text-danger">{error}</div> : null}
    </div>
  );
}
