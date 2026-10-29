/**
 * 统一错误映射：任何异常最终都变成 `ApiError` 形状的响应体。
 *
 * 约定的三层：
 *  - 路由层只抛 `ApiException`（状态码 + 机器可读 code），不自己拼响应体；
 *  - zod 校验失败 → 400，message 里带字段名，detail 带逐字段明细；
 *  - 其余未知异常 → 500 固定文案，堆栈只进日志、绝不进响应。
 */
import { ZodError, type ZodType } from 'zod';
import type { ApiError } from '../types.js';

export class ApiException extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(statusCode: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiException';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

export const notFound = (message: string): ApiException => new ApiException(404, 'not_found', message);

export const unprocessable = (code: string, message: string, detail?: unknown): ApiException =>
  new ApiException(422, code, message, detail);

export const serviceUnavailable = (code: string, message: string): ApiException =>
  new ApiException(503, code, message);

export const badGateway = (code: string, message: string, detail?: unknown): ApiException =>
  new ApiException(502, code, message, detail);

/**
 * 下层领域错误 → HTTP 语义。放在这里而不是散在各路由里，是因为
 * 「LLM 没配是 503、模型胡说才是 502」这条判断必须只有一处。
 * 认不出来的（code/status 都对不上）返回 undefined，交给调用方按真实故障处理。
 */
export function mapDomainError(err: unknown): ApiException | undefined {
  const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const dropped = (err as { dropped?: unknown }).dropped;

  switch (code) {
    case 'llm_not_configured':
    case 'novelty_not_configured':
      return serviceUnavailable(code, message);
    // 输入不够/产物全不合格：调用方能自救，属于 422
    case 'no_items':
    case 'all_invalid':
      return unprocessable(code, message, dropped === undefined ? undefined : { dropped });
    // 模型输出被截断或不是合法 JSON：上游的问题，502
    case 'llm_bad_output':
    case 'llm_output_truncated':
      return badGateway(code, message, dropped === undefined ? undefined : { dropped });
    default:
      break;
  }

  // LlmHttpError：模型端点返回非 2xx
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400) return badGateway('llm_upstream_error', message);
  return undefined;
}

interface FieldIssue {
  field: string;
  message: string;
}

/** 根级 refine 失败时 zod 的 path 是空的，用 body 兜底，保证 message 里总有个字段名 */
const fieldOf = (path: (string | number)[]): string => (path.length === 0 ? 'body' : path.join('.'));

export function validationException(error: ZodError): ApiException {  const fields: FieldIssue[] = error.issues.map((issue) => ({
    field: fieldOf(issue.path),
    message: issue.message,
  }));
  const first = fields[0];
  const message = first ? `${first.field}: ${first.message}` : '请求参数不合法';
  return new ApiException(400, 'validation_error', message, { fields });
}

/** fastify 自身的 4xx（坏 JSON、缺 content-type 等）没有业务 code，按状态码补一个稳定的 */
const CLIENT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'too_many_requests',
};

const isFastifyClientError = (err: unknown): err is { statusCode: number; message: string; code?: string } => {
  if (typeof err !== 'object' || err === null) return false;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
};

export interface MappedError {
  statusCode: number;
  body: ApiError;
}

export function toApiError(err: unknown): MappedError {
  if (err instanceof ApiException) {
    const body: ApiError = { error: { code: err.code, message: err.message } };
    if (err.detail !== undefined) body.error.detail = err.detail;
    return { statusCode: err.statusCode, body };
  }

  if (err instanceof ZodError) {
    const mapped = validationException(err);
    return toApiError(mapped);
  }

  // 领域错误（LLM/查新未配置、产物全不合格等）在这里统一映射：路由层不必各自 try/catch，
  // 否则新增一条链路（比如巡检）很容易忘了映射，前端就只能看到 internal_error。
  const domain = mapDomainError(err);
  if (domain) {
    const body: ApiError = { error: { code: domain.code, message: domain.message } };
    if (domain.detail !== undefined) body.error.detail = domain.detail;
    return { statusCode: domain.statusCode, body };
  }

  if (isFastifyClientError(err)) {
    return {
      statusCode: err.statusCode,
      body: { error: { code: CLIENT_CODES[err.statusCode] ?? 'request_error', message: err.message } },
    };
  }

  // 未知异常：对外只有一个安全文案，细节留在日志里（setErrorHandler 负责记录）
  return { statusCode: 500, body: { error: { code: 'internal_error', message: 'internal server error' } } };
}

/** 路由里的统一入口：校验失败直接抛 400，字段名进 message */
export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw validationException(result.error);
  return result.data;
}
