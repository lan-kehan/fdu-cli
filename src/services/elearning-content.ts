import { load } from 'cheerio';
import { z } from 'zod';
import { FduError } from '../core/errors';

const id = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/)]).transform(String);
const text = z.string().nullish();
const itemSchema = z.object({
  id, module_id: id.optional(), title: z.string(), type: z.string(), position: z.number().int().nonnegative().optional(),
  indent: z.number().int().nonnegative().optional(), content_id: id.nullish(), page_url: text, html_url: text, external_url: text,
  content_details: z.object({ due_at: text, unlock_at: text, lock_at: text, locked_for_user: z.boolean().optional(), lock_explanation: text }).nullish(),
});
const moduleSchema = z.object({
  id, name: z.string(), position: z.number().int().nonnegative().optional(),
  items_count: z.number().int().nonnegative().optional(), items: z.array(itemSchema).nullish(),
  state: text, unlock_at: text, require_sequential_progress: z.boolean().optional(),
});
const pageSchema = z.object({
  page_id: id, url: z.string().min(1), title: z.string(), html_url: text,
  updated_at: text, published: z.boolean().optional(), front_page: z.boolean().optional(),
  locked_for_user: z.boolean().optional(), lock_explanation: text, body: text,
});
const formatError = () => new FduError('FORMAT_CHANGED', 'eLearning 课程单元或页面格式异常。', '请在课程网页核对；向开发者反馈错误信息，不要附上课程内容或登录凭证。');

export function parseModules(data: unknown) {
  const parsed = z.array(moduleSchema).safeParse(data);
  if (!parsed.success) throw formatError();
  return parsed.data;
}
export function parseModuleItems(data: unknown, moduleId: string) {
  const parsed = z.array(itemSchema).safeParse(data);
  if (!parsed.success || parsed.data.some((i) => i.module_id && i.module_id !== moduleId)) throw formatError();
  return parsed.data;
}
export function moduleView(m: z.infer<typeof moduleSchema>, items: z.infer<typeof itemSchema>[]) {
  return {
    id: m.id, name: m.name, position: m.position ?? null, state: m.state ?? null,
    unlockAt: m.unlock_at ?? null, requireSequentialProgress: m.require_sequential_progress ?? null,
    itemsCount: m.items_count ?? items.length, visibleItemsCount: items.length,
    items: items.map((i) => ({
      id: i.id, title: i.title, type: i.type, position: i.position ?? null, indent: i.indent ?? 0,
      contentId: i.content_id ?? null, pageUrl: i.page_url ?? null, htmlUrl: i.html_url ?? null,
      externalUrl: i.external_url ?? null, dueAt: i.content_details?.due_at ?? null,
      unlockAt: i.content_details?.unlock_at ?? null, lockAt: i.content_details?.lock_at ?? null,
      lockedForUser: i.content_details?.locked_for_user ?? null, lockExplanation: i.content_details?.lock_explanation ?? null,
    })),
  };
}
export type CanvasModule = ReturnType<typeof moduleView>;

export function pageView(data: unknown) {
  const parsed = pageSchema.safeParse(data);
  if (!parsed.success) throw formatError();
  const p = parsed.data;
  return {
    id: p.page_id, url: p.url, title: p.title, htmlUrl: p.html_url ?? null,
    updatedAt: p.updated_at ?? null, published: p.published ?? null, frontPage: p.front_page ?? null,
    lockedForUser: p.locked_for_user ?? null, lockExplanation: p.lock_explanation ?? null,
  };
}
export function parsePages(data: unknown) {
  if (!Array.isArray(data)) throw formatError();
  return data.map(pageView);
}
export function pageDetailView(data: unknown, courseId: string) {
  const parsed = pageSchema.safeParse(data);
  if (!parsed.success) throw formatError();
  const p = parsed.data;
  const body = p.locked_for_user ? null : p.body ?? null;
  const $ = load(body ?? '');
  $('script, style, noscript, iframe, form').remove();
  const links = $('a[href]').toArray().flatMap((a) => {
    try {
      const url = new URL($(a).attr('href')!, `https://elearning.fudan.edu.cn/courses/${courseId}/pages/${encodeURIComponent(p.url)}`);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
        ? [{ title: $(a).text().trim(), url: url.href }] : [];
    } catch { return []; }
  });
  return { ...pageView(p), body, text: body === null ? null : htmlText(body), links };
}
/** HTML 转可读纯文本：去掉脚本、样式、表单，保留换行。 */
export function htmlText(html: string): string {
  const $ = load(html);
  $('script, style, noscript, iframe, form').remove();
  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre').append('\n');
  $('td, th').append('\t');
  return $.root().text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}
export type CanvasPage = ReturnType<typeof pageView>;
export type CanvasPageDetail = ReturnType<typeof pageDetailView>;

export function checkCourseId(courseId: string) {
  if (!/^[1-9]\d*$/.test(courseId)) throw new FduError('BAD_ARGS', '课程 id 必须为正整数。', '用 `fdu elearning courses` 查询课程 id。');
}
export function checkPageKey(page: string) {
  if (!page || page.length > 300 || page === '.' || page === '..' || /[\\/?#\u0000-\u001f]/.test(page)) {
    throw new FduError('BAD_ARGS', '页面标识格式不正确。', '传入 elearning pages 返回的 url 或 modules 返回的 pageUrl；按 id 查时传 page_id:123。');
  }
}
export async function readContent<T>(read: () => Promise<T>): Promise<T> {
  return readCanvas({
    denied: ['没有权限查看这部分课程内容。', '在 eLearning 网页确认当前账号已加入课程、栏目和内容已开放。'],
    missing: ['没有找到课程单元或页面。', '核对课程 id 和页面标识；页面可能已删除或没有对你开放。'],
    format: formatError,
  }, read);
}
/** 把 Canvas 接口的 403 / 404 / 格式异常统一成带提示的 FduError。 */
export async function readCanvas<T>(on: { denied: [string, string]; missing: [string, string]; format: () => FduError }, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403) throw new FduError('PERMISSION', ...on.denied);
    if (status === 404) throw new FduError('NOT_FOUND', ...on.missing);
    if ((e as Error).message === 'eLearning 返回的数据格式不正确') throw on.format();
    throw e;
  }
}
export { id as canvasId };
