import { z } from 'zod';
import { FduError } from '../core/errors';
import { canvasId as id, htmlText, readCanvas } from './elearning-content';

const text = z.string().nullish();
const num = z.number().nullish();
const bool = z.boolean().nullish();
const attachmentSchema = z.object({ id, display_name: text, filename: text, url: text, size: num, 'content-type': text });
const attachmentView = (f: z.infer<typeof attachmentSchema>) => ({
  id: f.id, name: f.display_name ?? f.filename ?? `文件 ${f.id}`, url: f.url ?? null, size: f.size ?? null, contentType: f['content-type'] ?? null,
});
const checkId = (value: string, what: string, hint: string) => {
  if (!/^[1-9]\d*$/.test(value)) throw new FduError('BAD_ARGS', `${what} id 必须为正整数。`, hint);
};

// ---------- 讨论区 ----------
const topicSchema = z.object({
  id, title: text, message: text, html_url: text, posted_at: text, last_reply_at: text,
  discussion_subentry_count: num, unread_count: num, read_state: text,
  user_name: text, author: z.object({ display_name: text }).nullish(),
  pinned: bool, locked: bool, locked_for_user: bool, lock_explanation: text,
  require_initial_post: bool, assignment_id: id.nullish(), attachments: z.array(attachmentSchema).nullish(),
});
interface RawEntry {
  id: string; user_id?: string | null; parent_id?: string | null; created_at?: string | null; updated_at?: string | null;
  message?: string | null; deleted?: boolean | null; attachment?: z.infer<typeof attachmentSchema> | null; replies?: RawEntry[] | null;
}
const entrySchema: z.ZodType<RawEntry> = z.lazy(() => z.object({
  id, user_id: id.nullish(), parent_id: id.nullish(), created_at: text, updated_at: text,
  message: text, deleted: bool, attachment: attachmentSchema.nullish(), replies: z.array(entrySchema).nullish(),
}));
const viewSchema = z.object({
  // 匿名讨论里参与者没有数字 id
  participants: z.array(z.object({ id: id.nullish().catch(null), display_name: text })).nullish(),
  unread_entries: z.array(id).nullish(),
  view: z.array(entrySchema),
});
const discussionFormat = () => new FduError('FORMAT_CHANGED', 'eLearning 讨论区数据格式异常。', '请在课程网页的「讨论」里核对；向开发者反馈错误信息，不要附上讨论内容或登录凭证。');

function topicView(t: z.infer<typeof topicSchema>) {
  return {
    id: t.id, title: t.title ?? '', author: t.author?.display_name ?? t.user_name ?? null,
    postedAt: t.posted_at ?? null, lastReplyAt: t.last_reply_at ?? null,
    replies: t.discussion_subentry_count ?? null, unread: t.unread_count ?? null, readState: t.read_state ?? null,
    pinned: t.pinned ?? null, locked: t.locked ?? null, lockedForUser: t.locked_for_user ?? null, lockExplanation: t.lock_explanation ?? null,
    /** 需要先发帖才能看到别人的回帖 */
    requireInitialPost: t.require_initial_post ?? null,
    /** 计分讨论对应的作业 id */
    assignmentId: t.assignment_id ?? null, htmlUrl: t.html_url ?? null,
    /** 主题正文的纯文本；锁定时为 null */
    text: t.locked_for_user || t.message == null ? null : htmlText(t.message),
    attachments: (t.attachments ?? []).map(attachmentView),
  };
}
export type CanvasDiscussionTopic = ReturnType<typeof topicView>;
export function parseTopics(data: unknown): CanvasDiscussionTopic[] {
  const parsed = z.array(topicSchema).safeParse(data);
  if (!parsed.success) throw discussionFormat();
  return parsed.data.map(topicView);
}

export interface CanvasDiscussionEntry {
  id: string; parentId: string | null; author: string | null; createdAt: string | null; updatedAt: string | null;
  deleted: boolean; unread: boolean; text: string | null;
  attachments: ReturnType<typeof attachmentView>[]; replies: CanvasDiscussionEntry[];
}
export function discussionView(topic: unknown, view: unknown) {
  const t = topicSchema.safeParse(topic);
  const v = viewSchema.safeParse(view);
  if (!t.success || !v.success) throw discussionFormat();
  const names = new Map((v.data.participants ?? []).flatMap((p) => p.id ? [[p.id, p.display_name ?? null] as const] : []));
  const unread = new Set(v.data.unread_entries ?? []);
  let count = 0;
  const entry = (e: RawEntry): CanvasDiscussionEntry => {
    count++;
    return {
      id: e.id, parentId: e.parent_id ?? null, author: e.user_id ? names.get(e.user_id) ?? null : null,
      createdAt: e.created_at ?? null, updatedAt: e.updated_at ?? null, deleted: !!e.deleted, unread: unread.has(e.id),
      text: e.deleted || e.message == null ? null : htmlText(e.message),
      attachments: e.attachment ? [attachmentView(e.attachment)] : [], replies: (e.replies ?? []).map(entry),
    };
  };
  const entries = v.data.view.map(entry);
  return { ...topicView(t.data), entriesCount: count, entries };
}
export type CanvasDiscussion = ReturnType<typeof discussionView>;
export const checkTopicId = (topicId: string) => checkId(topicId, '讨论主题', '用 `fdu elearning discussions --course <课程>` 查询主题 id。');
export const readDiscussions = <T>(read: () => Promise<T>) => readCanvas({
  denied: ['没有权限查看这个讨论。', '讨论区可能没有对学生开放，或者要求先在网页上发帖才能看到别人的回帖。'],
  missing: ['没有找到讨论区或讨论主题。', '用 `fdu elearning discussions --course <课程>` 核对主题 id；这门课可能没有开讨论区。'],
  format: discussionFormat,
}, read);

// ---------- 站内信 ----------
const conversationSchema = z.object({
  id, subject: text, workflow_state: text, last_message: text, last_message_at: text,
  message_count: num, starred: bool, context_name: text,
  participants: z.array(z.object({ id, name: text })).nullish(),
});
const conversationDetailSchema = conversationSchema.extend({
  messages: z.array(z.object({
    id, created_at: text, body: text, author_id: id.nullish(), generated: bool,
    attachments: z.array(attachmentSchema).nullish(),
  })),
});
const inboxFormat = () => new FduError('FORMAT_CHANGED', 'eLearning 站内信数据格式异常。', '请在 eLearning 网页的「收件箱」里核对；向开发者反馈错误信息，不要附上信件内容或登录凭证。');

function conversationView(c: z.infer<typeof conversationSchema>) {
  return {
    id: c.id, subject: c.subject ?? '',
    /** read 已读、unread 未读、archived 已归档 */
    state: c.workflow_state ?? null,
    lastMessage: c.last_message ?? null, lastMessageAt: c.last_message_at ?? null,
    messageCount: c.message_count ?? null, starred: c.starred ?? null,
    /** 所属课程或小组的名称 */
    context: c.context_name ?? null,
    participants: (c.participants ?? []).map((p) => p.name ?? null),
  };
}
export type CanvasConversation = ReturnType<typeof conversationView>;
export function parseConversations(data: unknown): CanvasConversation[] {
  const parsed = z.array(conversationSchema).safeParse(data);
  if (!parsed.success) throw inboxFormat();
  return parsed.data.map(conversationView);
}
export function conversationDetailView(data: unknown, conversationId: string) {
  const parsed = conversationDetailSchema.safeParse(data);
  if (!parsed.success || parsed.data.id !== conversationId) throw inboxFormat();
  const c = parsed.data;
  const names = new Map((c.participants ?? []).map((p) => [p.id, p.name ?? null]));
  return {
    ...conversationView(c),
    /** 新的在前（Canvas 的顺序） */
    messages: c.messages.map((m) => ({
      id: m.id, author: m.author_id ? names.get(m.author_id) ?? null : null, createdAt: m.created_at ?? null,
      /** 系统自动生成的消息（如「某人加入了会话」） */
      generated: m.generated ?? null, text: m.body ?? null,
      attachments: (m.attachments ?? []).map(attachmentView),
    })),
  };
}
export type CanvasConversationDetail = ReturnType<typeof conversationDetailView>;
export const INBOX_SCOPES = ['inbox', 'unread', 'starred', 'sent', 'archived'] as const;
export type InboxScope = typeof INBOX_SCOPES[number];
export const checkConversationId = (conversationId: string) => checkId(conversationId, '会话', '用 `fdu elearning inbox` 查询会话 id。');
export const readInbox = <T>(read: () => Promise<T>) => readCanvas({
  denied: ['没有权限查看 eLearning 站内信。', '学校可能没有开放站内信功能；在 eLearning 网页左侧的「收件箱」确认。'],
  missing: ['没有找到这个会话。', '用 `fdu elearning inbox` 核对会话 id；已归档的用 --scope archived 查。'],
  format: inboxFormat,
}, read);
