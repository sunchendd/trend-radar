/**
 * chat 模块内部类型。为什么这么设计：
 *
 * 这里只放「对话编排」自己的形状（事件、工具决策、工具结果），刻意不依赖
 * http/deps.ts 的 HttpDeps——orchestrator/tools 通过**结构化类型**（ChatDeps /
 * ToolContext）取能力，测试里不需要构造一个完整的 HttpDeps，只需要实现用到的
 * 几个方法；和 http 层的耦合仅限于 routes.ts 注册处与 errors.ts 的错误翻译。
 */

/** 模型在决策轮里可以选的动作：七个工具 + final（直接合成回答） */
export type ChatToolName =
  | 'search_local'
  | 'search_arxiv'
  | 'search_patents'
  | 'generate_ideas'
  | 'export_disclosure'
  | 'check_novelty'
  | 'draft_claims';
export type ChatAction = ChatToolName | 'final';

/** SSE status 事件的 step 取值（routes.ts 帧契约的一部分） */
export type ChatStep = 'plan' | ChatToolName | 'compose';

/** 模型决策轮的输出（extractJson 之后期望的形状） */
export interface ChatDecision {
  thought: string;
  action: ChatAction;
  args: Record<string, unknown>;
}

/**
 * sources 事件与证据清单共用的条目形态。
 * kind 是 chat 面向前端的超集：库内三类 + 专利 + 选题。
 */
export type ChatSourceKind = 'paper' | 'news' | 'release' | 'patent' | 'idea';

export interface ChatSourceItem {
  title: string;
  url: string;
  kind: ChatSourceKind;
  meta: Record<string, unknown>;
}

/** 工具执行结果的统一形态：条目列表 + 可选备注（失败/降级时 items 为空、note 说明原因） */
export interface ToolResult {
  items: ChatSourceItem[];
  note?: string;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** 一次对话请求（HTTP 校验之后、进入编排之前） */
export interface ChatTurn {
  message: string;
  history: ChatHistoryMessage[];
}

/** 编排器对外发事件的回调集合（routes.ts 把它们接到 SSE writer 上） */
export interface ChatEvents {
  status(step: ChatStep, label: string): void;
  sources(items: ChatSourceItem[]): void;
  token(text: string): void;
}

export interface ChatOutcome {
  messageId: string;
  toolsUsed: ChatToolName[];
  answer: string;
}
