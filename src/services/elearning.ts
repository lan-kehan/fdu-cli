import { NeedLoginError, PLATFORM_URLS, isPermissionDenied, isUisLoginUrl, type FudanAuth } from '../core/fudan-auth';
import { FduError } from '../core/errors';
import { z } from 'zod';
import { parseEnrollmentGrades, parseGradeGroups, readGradeData, type CanvasCourseGrades, type CourseTotals } from './elearning-grades';
import { checkConversationId, checkTopicId, conversationDetailView, discussionView, parseConversations, parseTopics, readDiscussions, readInbox, type CanvasConversation, type CanvasConversationDetail, type CanvasDiscussion, type CanvasDiscussionTopic, type InboxScope } from './elearning-messages';
import { checkCourseId, checkPageKey, moduleView, pageDetailView, parseModuleItems, parseModules, parsePages, readContent, type CanvasModule, type CanvasPage, type CanvasPageDetail } from './elearning-content';

const canvasId = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^[1-9]\d*$/)]).transform(String);
const nullableText = z.string().nullish();
const attachmentSchema = z.object({
  id: canvasId, display_name: nullableText, filename: nullableText, url: nullableText,
  size: z.number().nonnegative().nullish(), 'content-type': nullableText,
});
const submissionRecordSchema = z.object({
  id: canvasId.nullish(), assignment_id: canvasId,
  workflow_state: z.string().min(1), attempt: z.number().int().nonnegative().nullish(),
  submission_type: nullableText, submitted_at: nullableText, body: nullableText, url: nullableText,
  attachments: z.array(attachmentSchema).nullish(), score: z.number().nullish(), grade: nullableText,
  graded_at: nullableText, grade_matches_current_submission: z.boolean().nullish(),
  excused: z.boolean().nullish(), late: z.boolean().nullish(), missing: z.boolean().nullish(),
});
const submissionDetailSchema = submissionRecordSchema.extend({
  submission_comments: z.array(z.object({
    id: canvasId.nullish(), author_name: nullableText, comment: nullableText, created_at: nullableText,
    attachments: z.array(attachmentSchema).nullish(),
  })).nullish(),
  submission_history: z.array(submissionRecordSchema).nullish(),
});
const assignmentDetailSchema = z.object({
  id: canvasId, course_id: canvasId, name: z.string(), description: nullableText,
  html_url: z.string(), submission_types: z.array(z.string()), due_at: nullableText, updated_at: nullableText,
  points_possible: z.number().nonnegative().nullish(), allowed_attempts: z.number().int().min(-1).nullish(),
  allowed_extensions: z.array(z.string()).nullish(), locked_for_user: z.boolean().nullish(),
  unlock_at: nullableText, lock_at: nullableText, group_category_id: canvasId.nullish(),
});

type RawSubmissionRecord = z.infer<typeof submissionRecordSchema>;
const attachmentView = (f: z.infer<typeof attachmentSchema>) => ({
  id: f.id, name: f.display_name ?? f.filename ?? `文件 ${f.id}`, url: f.url ?? null,
  size: f.size ?? null, contentType: f['content-type'] ?? null,
});
const submissionRecordView = (s: RawSubmissionRecord) => ({
  id: s.id ?? null, state: s.workflow_state, attempt: s.attempt ?? null,
  submissionType: s.submission_type ?? null, submittedAt: s.submitted_at ?? null,
  body: s.body ?? null, url: s.url ?? null, attachments: (s.attachments ?? []).map(attachmentView),
  score: s.score ?? null, grade: s.grade ?? null, gradedAt: s.graded_at ?? null,
  gradeMatchesCurrentSubmission: s.grade_matches_current_submission ?? null,
  excused: s.excused ?? null, late: s.late ?? null, missing: s.missing ?? null,
});

export interface CanvasAssignmentDetail extends CanvasAssignment {
  pointsPossible: number | null;
  allowedAttempts: number | null;
  allowedExtensions: string[] | null;
  lockedForUser: boolean | null;
  unlockAt: string | null;
  lockAt: string | null;
  groupAssignment: boolean;
  submission: ReturnType<typeof submissionRecordView> & {
    /** null 表示接口未返回；空数组表示没有评语。 */
    comments: { id: string | null; author: string | null; text: string | null; createdAt: string | null; attachments: ReturnType<typeof attachmentView>[] }[] | null;
    history: ReturnType<typeof submissionRecordView>[] | null;
  };
}

/** eLearning（Canvas）平台数据类型：只保留用得到的字段。 */
export interface CanvasCourse {
  id: string;
  name: string;
  /** Canvas 的 course_code，期望形如 COMP130004.01（格式待实测） */
  courseCode: string;
  term?: string;
  teachers: { name: string; email?: string; role: 'teacher' | 'ta' }[];
}

export interface CanvasAssignment {
  id: string;
  courseId: string;
  name: string;
  description?: string;
  dueAt?: string;
  htmlUrl: string;
  /** 'online' 表示网上提交；'on_paper' / 'none' 表示线下或无需提交 */
  submissionTypes: string[];
  /** 本人有提交记录（已提交 / 已评分 / 待审阅） */
  submitted: boolean;
  submittedAt?: string;
  updatedAt?: string;
  /**
   * 在 eLearning 上被标记为完成但不一定有本人提交记录，例如：
   * - 学生在「待办 / 计划」里勾选了「标记为完成」（组作业由组长提交、线下提交等）；
   * - 单元（模块）里要求「标记为完成」的作业，已点过完成；
   * - 教师设置了免交（excused）。
   */
  markedDone?: boolean;
}

/** 作业在平台上是否算完成：有提交记录，或已标记完成 / 免交 */
export function isAssignmentDone(a: Pick<CanvasAssignment, 'submitted' | 'markedDone'>): boolean {
  return a.submitted || !!a.markedDone;
}

export interface CanvasAnnouncement {
  id: string;
  courseId: string;
  title: string;
  message: string;
  postedAt: string;
  htmlUrl: string;
}

/** 课程文件（课件、讲义等） */
export interface CanvasFile {
  id: string;
  name: string;
  size?: number;
  contentType?: string;
  updatedAt?: string;
  /** 所在文件夹或单元，例如「课件」「第 5 讲」 */
  folder?: string;
}

/** 下载到内存的文件内容 */
export interface DownloadedFile { name: string; contentType?: string; data: Uint8Array }

/** 单个文件最大 200 MB，再大的请用户在网页上下载 */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/** 连接器的平台客户端接口。真实实现和演示实现都满足它。 */
export interface ElearningClient {
  listCourses(): Promise<CanvasCourse[]>;
  listAssignments(courseId: string): Promise<CanvasAssignment[]>;
  getAssignment?(courseId: string, assignmentId: string): Promise<CanvasAssignmentDetail>;
  listModules?(courseId: string): Promise<CanvasModule[]>;
  listPages?(courseId: string, search?: string): Promise<CanvasPage[]>;
  getPage?(courseId: string, page: string): Promise<CanvasPageDetail>;
  listAnnouncements(courseIds: string[], since?: string): Promise<CanvasAnnouncement[]>;
  /** 轻量检查会话是否有效 */
  ping(): Promise<boolean>;
  /** 课程文件列表（只读） */
  listFiles?(courseId: string, search?: string): Promise<CanvasFile[]>;
  /** 下载一个课程文件（只读） */
  downloadFile?(fileId: string): Promise<DownloadedFile>;
}

/** 通过 UIS 共享会话访问 Canvas REST API 的真实实现（只读）。 */
export class CanvasClient implements ElearningClient {
  private readonly base = PLATFORM_URLS.elearning.base;

  constructor(private readonly auth: FudanAuth) {}

  private async request(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.auth.fetch('elearning', url, { headers: { Accept: 'application/json' } });
      if (isUisLoginUrl(res.url)) throw new NeedLoginError('elearning');
      if (res.status === 401) {
        // 已登录但没有权限（例如课程花名册不对学生开放）按 403 处理，由调用方决定跳过，不当成登录过期。
        if (await isPermissionDenied(res)) throw Object.assign(new Error('没有权限查看这部分 eLearning 内容'), { status: 403 });
        throw new NeedLoginError('elearning');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retry = res.headers.get('retry-after');
        const seconds = retry ? Number(retry) : NaN;
        const wait = Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - Date.now() : 500 * 2 ** attempt;
        // 不提前重试服务器要求长时间等待的请求。
        if (wait > 5000) throw new Error('eLearning 请求受限，请稍后再同步');
        await res.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number.isFinite(wait) ? wait : 500)));
        continue;
      }
      if (!res.ok) throw Object.assign(new Error(`eLearning API 返回 ${res.status}`), { status: res.status });
      return res;
    }
  }

  private async get<T>(path: string, params: Record<string, string | string[]> = {}, maxRows = Infinity): Promise<T> {
    const first = new URL(`/api/v1${path}`, this.base);
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) first.searchParams.append(k, one);
    }
    first.searchParams.set('per_page', String(Math.min(100, maxRows)));
    let url: URL | undefined = first;
    const seen = new Set<string>();
    const rows: unknown[] = [];
    while (url) {
      if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password || seen.has(url.href)) {
        throw new Error('eLearning 返回了异常分页链接，请稍后重试');
      }
      seen.add(url.href);
      const res = await this.request(url.href);
      if (!res.headers.get('content-type')?.includes('json')) {
        throw new Error('eLearning 未返回接口数据，请重新登录后同步');
      }
      const data: unknown = await res.json();
      if (path === '/users/self') {
        if (!data || typeof data !== 'object' || !('id' in data) || !data.id) throw new Error('无法确认 eLearning 登录身份');
        return data as T;
      }
      if (!Array.isArray(data)) throw new Error('eLearning 返回的数据格式不正确');
      rows.push(...data);
      const next: string | undefined = res.headers.get('link')?.split(/,(?=\s*<)/)
        .find((part) => /;\s*rel="?next"?(?:\s*;|\s*$)/i.test(part))?.match(/<([^>]+)>/)?.[1];
      url = next && rows.length < maxRows ? new URL(next, url) : undefined;
    }
    return (rows.length > maxRows ? rows.slice(0, maxRows) : rows) as T;
  }

  /** 返回单个对象的接口（例如某个文件的信息） */
  private async getObject<T>(path: string, params: Record<string, string[]> = {}): Promise<T> {
    const url = new URL(`/api/v1${path}`, this.base);
    for (const [key, values] of Object.entries(params)) for (const value of values) url.searchParams.append(key, value);
    const res = await this.request(url.href);
    if (!res.headers.get('content-type')?.includes('json')) throw new Error('eLearning 未返回接口数据，请重新登录后同步');
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('eLearning 返回的数据格式不正确');
    return data as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.get('/users/self');
      return true;
    } catch (e) {
      if (e instanceof NeedLoginError) return false;
      throw e;
    }
  }

  async listCourses(): Promise<CanvasCourse[]> {
    type Raw = {
      id: number; name: string; course_code: string; term?: { name: string };
      teachers?: { display_name: string; email?: string }[];
    };
    const raw = await this.get<Raw[]>('/courses', {
      enrollment_state: 'active',
      'include[]': ['term', 'teachers'],
    });
    const courses: CanvasCourse[] = [];
    for (const c of raw) {
      const teachers: CanvasCourse['teachers'] = (c.teachers ?? []).map((t) => ({ name: t.display_name, email: t.email, role: 'teacher' }));
      // 部分课程不允许学生查看名册；权限不足不妨碍同步课程和作业。
      for (const role of ['teacher', 'ta'] as const) {
        try {
          const staff = await this.get<{ name: string; email?: string }[]>(`/courses/${c.id}/users`, { 'enrollment_type[]': [role] });
          for (const person of staff) {
            const existing = teachers.find((t) => t.role === role && t.name === person.name);
            if (existing) existing.email = person.email ?? existing.email;
            else teachers.push({ name: person.name, email: person.email, role });
          }
        } catch (error) {
          if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error;
        }
      }
      courses.push({ id: String(c.id), name: c.name, courseCode: c.course_code, term: c.term?.name, teachers });
    }
    return courses;
  }

  /** 「待办 / 计划」里被勾选为完成的作业 ID（一次同步内缓存 1 分钟，避免每门课重复请求） */
  private plannerMarks?: { at: number; ids: Promise<Set<string>> };

  private markedInPlanner(): Promise<Set<string>> {
    if (!this.plannerMarks || Date.now() - this.plannerMarks.at > 60_000) {
      type Override = { plannable_type: string; plannable_id: number | string; marked_complete?: boolean };
      const ids = this.get<Override[]>('/planner/overrides')
        .then((rows) => new Set(rows.filter((o) => o.plannable_type === 'assignment' && o.marked_complete).map((o) => String(o.plannable_id))))
        // 计划功能未开放或无权限时，不影响作业同步
        .catch((error) => {
          if ([403, 404].includes((error as { status?: number }).status ?? 0)) return new Set<string>();
          throw error;
        });
      this.plannerMarks = { at: Date.now(), ids };
    }
    return this.plannerMarks.ids;
  }

  /** 单元（模块）里要求「标记为完成」且已完成的作业 ID */
  private async markedInModules(courseId: string): Promise<Set<string>> {
    type Module = { items?: { type: string; content_id?: number | string; completion_requirement?: { type: string; completed?: boolean } }[] };
    try {
      const modules = await this.get<Module[]>(`/courses/${courseId}/modules`, { 'include[]': ['items'] });
      return new Set(modules.flatMap((m) => m.items ?? [])
        .filter((i) => i.type === 'Assignment' && i.content_id != null && i.completion_requirement?.type === 'must_mark_done' && i.completion_requirement.completed)
        .map((i) => String(i.content_id)));
    } catch (error) {
      if ([403, 404].includes((error as { status?: number }).status ?? 0)) return new Set<string>();
      throw error;
    }
  }

  async listAssignments(courseId: string): Promise<CanvasAssignment[]> {
    type Raw = {
      id: number; course_id: number; name: string; description?: string; due_at?: string;
      html_url: string; submission_types: string[]; updated_at?: string;
      submission?: { workflow_state: string; submitted_at?: string; excused?: boolean };
    };
    const raw = await this.get<Raw[]>(`/courses/${courseId}/assignments`, { 'include[]': ['submission'] });
    const [planner, modules] = await Promise.all([this.markedInPlanner(), this.markedInModules(courseId)]);
    return raw.map((a) => ({
      id: String(a.id),
      courseId: String(a.course_id),
      name: a.name,
      description: a.description,
      dueAt: a.due_at ?? undefined,
      htmlUrl: a.html_url,
      submissionTypes: a.submission_types,
      submitted: !!a.submission && ['submitted', 'graded', 'pending_review'].includes(a.submission.workflow_state),
      submittedAt: a.submission?.submitted_at,
      updatedAt: a.updated_at,
      markedDone: planner.has(String(a.id)) || modules.has(String(a.id)) || a.submission?.excused === true,
    }));
  }

  /** 读取单份作业及本人提交、评语和历史；不请求会标记已读的 read_status。 */
  async getAssignment(courseId: string, assignmentId: string): Promise<CanvasAssignmentDetail> {
    if (!/^[1-9]\d*$/.test(courseId) || !/^[1-9]\d*$/.test(assignmentId)) {
      throw new FduError('BAD_ARGS', '课程和作业 id 必须为正整数。', '用 `fdu elearning assignments --course <课程>` 查询作业 id。');
    }
    const path = `/courses/${courseId}/assignments/${assignmentId}`;
    let rawAssignment: unknown;
    let rawSubmission: unknown;
    try {
      [rawAssignment, rawSubmission] = await Promise.all([
        this.getObject(path),
        this.getObject(`${path}/submissions/self`, { 'include[]': ['submission_comments', 'submission_history'] }),
      ]);
    } catch (e) {
      if ((e as { status?: number }).status === 404) throw new FduError('NOT_FOUND', '没有找到这份作业或本人的提交记录。', '核对 --course 和 --assignment，或在作业网页查看当前账号的访问权限。');
      throw e;
    }
    const assignment = assignmentDetailSchema.safeParse(rawAssignment);
    const submission = submissionDetailSchema.safeParse(rawSubmission);
    if (!assignment.success || !submission.success || assignment.data.id !== assignmentId || assignment.data.course_id !== courseId
      || submission.data.assignment_id !== assignmentId || submission.data.submission_history?.some((s) => s.assignment_id !== assignmentId)) {
      throw new FduError('FORMAT_CHANGED', 'eLearning 作业详情或提交记录格式异常。', '请在网页核对；向开发者反馈这条错误，不要附上作业内容、成绩或登录凭证。');
    }
    const a = assignment.data;
    const s = submission.data;
    const [planner, modules] = await Promise.all([this.markedInPlanner(), this.markedInModules(courseId)]);
    return {
      id: a.id, courseId: a.course_id, name: a.name, description: a.description ?? undefined,
      dueAt: a.due_at ?? undefined, htmlUrl: a.html_url, submissionTypes: a.submission_types,
      submitted: ['submitted', 'graded', 'pending_review'].includes(s.workflow_state),
      submittedAt: s.submitted_at ?? undefined, updatedAt: a.updated_at ?? undefined,
      markedDone: planner.has(a.id) || modules.has(a.id) || s.excused === true,
      pointsPossible: a.points_possible ?? null, allowedAttempts: a.allowed_attempts ?? null,
      allowedExtensions: a.allowed_extensions ?? null, lockedForUser: a.locked_for_user ?? null,
      unlockAt: a.unlock_at ?? null, lockAt: a.lock_at ?? null, groupAssignment: !!a.group_category_id,
      submission: {
        ...submissionRecordView(s),
        comments: s.submission_comments?.map((c) => ({
          id: c.id ?? null, author: c.author_name ?? null, text: c.comment ?? null, createdAt: c.created_at ?? null,
          attachments: (c.attachments ?? []).map(attachmentView),
        })) ?? null,
        history: s.submission_history?.map(submissionRecordView) ?? null,
      },
    };
  }

  /** 课程单元及其全部可见条目；只列元数据，不访问会记录学习进度的模块跳转地址。 */
  async listModules(courseId: string): Promise<CanvasModule[]> {
    checkCourseId(courseId);
    return readContent(async () => {
      const modules = parseModules(await this.get(`/courses/${courseId}/modules`, { 'include[]': ['items', 'content_details'] }));
      const result: CanvasModule[] = [];
      for (const m of modules) {
        // Canvas 可以省略大单元的内联条目；必须另查完整分页，不能误报为空单元。
        const raw = !m.items || (m.items_count !== undefined && m.items_count > m.items.length)
          ? await this.get(`/courses/${courseId}/modules/${m.id}/items`, { 'include[]': ['content_details'] }) : m.items;
        result.push(moduleView(m, parseModuleItems(raw, m.id)));
      }
      return result;
    });
  }

  async listPages(courseId: string, search?: string): Promise<CanvasPage[]> {
    checkCourseId(courseId);
    return readContent(async () => parsePages(await this.get(`/courses/${courseId}/pages`, search ? { search_term: search } : {})));
  }

  async getPage(courseId: string, page: string): Promise<CanvasPageDetail> {
    checkCourseId(courseId);
    checkPageKey(page);
    return readContent(async () => pageDetailView(await this.getObject(`/courses/${courseId}/pages/${encodeURIComponent(page)}`), courseId));
  }

  /** 本人以学生身份加入的各门课的总评（一次请求）；老师没有开放总评时分数为 null。 */
  async listGradeTotals(): Promise<Map<string, CourseTotals>> {
    return readGradeData(async () => parseEnrollmentGrades(await this.get('/users/self/enrollments', { 'type[]': ['StudentEnrollment'], 'state[]': ['active'] })));
  }

  /** 一门课的作业组（权重、去掉最低分规则）和每项作业的本人得分、班级统计。 */
  async getCourseGrades(courseId: string): Promise<CanvasCourseGrades> {
    checkCourseId(courseId);
    return readGradeData(async () => {
      const [course, groups] = await Promise.all([
        this.getObject<{ apply_assignment_group_weights?: unknown }>(`/courses/${courseId}`),
        this.get(`/courses/${courseId}/assignment_groups`, { 'include[]': ['assignments', 'submission', 'score_statistics'] }),
      ]);
      const weighted = course.apply_assignment_group_weights;
      return { weighted: typeof weighted === 'boolean' ? weighted : null, groups: parseGradeGroups(groups) };
    });
  }

  /** 课程讨论区的主题（不含公告）；只读列表，不改变已读状态。 */
  async listDiscussions(courseId: string): Promise<CanvasDiscussionTopic[]> {
    checkCourseId(courseId);
    return readDiscussions(async () => parseTopics(await this.get(`/courses/${courseId}/discussion_topics`)));
  }

  /** 一个讨论主题和全部回帖（树状）。读取 view 接口不会把回帖标为已读。 */
  async getDiscussion(courseId: string, topicId: string): Promise<CanvasDiscussion> {
    checkCourseId(courseId);
    checkTopicId(topicId);
    const path = `/courses/${courseId}/discussion_topics/${topicId}`;
    return readDiscussions(async () => {
      const [topic, view] = await Promise.all([this.getObject(path), this.getObject(`${path}/view`)]);
      return discussionView(topic, view);
    });
  }

  /** 站内信会话列表，新的在前；列表接口不改变已读状态。 */
  async listConversations(scope: InboxScope = 'inbox', limit = 30): Promise<CanvasConversation[]> {
    return readInbox(async () => parseConversations(await this.get('/conversations', { scope }, limit)));
  }

  /** 一个会话的全部消息。Canvas 默认会把会话标为已读，必须显式关闭。 */
  async getConversation(conversationId: string): Promise<CanvasConversationDetail> {
    checkConversationId(conversationId);
    return readInbox(async () => conversationDetailView(await this.getObject(`/conversations/${conversationId}`, { auto_mark_as_read: ['false'] }), conversationId));
  }

  /**
   * 课程文件。先读「文件」栏目；老师把「文件」栏目隐藏时（没有权限），改从「单元」里找文件条目。
   */
  async listFiles(courseId: string, search?: string): Promise<CanvasFile[]> {
    type RawFile = { id: number; display_name?: string; filename?: string; size?: number; 'content-type'?: string; updated_at?: string; folder_id?: number; locked_for_user?: boolean; hidden_for_user?: boolean };
    const toFile = (f: RawFile, folder?: string): CanvasFile => ({
      id: String(f.id), name: f.display_name ?? f.filename ?? `文件 ${f.id}`, size: f.size, contentType: f['content-type'], updatedAt: f.updated_at, folder,
    });
    const term = search?.trim();
    try {
      const params: Record<string, string> = { sort: 'updated_at', order: 'desc' };
      if (term && term.length >= 2) params.search_term = term;
      const [files, folders] = await Promise.all([
        this.get<RawFile[]>(`/courses/${courseId}/files`, params),
        this.get<{ id: number; full_name?: string; name?: string }[]>(`/courses/${courseId}/folders`).catch(() => []),
      ]);
      const folderName = new Map(folders.map((f) => [f.id, (f.full_name ?? f.name ?? '').replace(/^course files\/?/, '')]));
      return files.filter((f) => !f.locked_for_user && !f.hidden_for_user).map((f) => toFile(f, folderName.get(f.folder_id ?? -1) || undefined));
    } catch (error) {
      if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error;
    }
    type Module = { name?: string; items?: { type: string; content_id?: number; title?: string }[] };
    const modules = await this.get<Module[]>(`/courses/${courseId}/modules`, { 'include[]': ['items'] });
    const out: CanvasFile[] = [];
    for (const m of modules) {
      for (const item of m.items ?? []) {
        if (item.type !== 'File' || item.content_id == null) continue;
        if (term && !(item.title ?? '').toLowerCase().includes(term.toLowerCase()) && !(m.name ?? '').toLowerCase().includes(term.toLowerCase())) continue;
        try {
          const f = await this.getObject<RawFile>(`/courses/${courseId}/files/${item.content_id}`);
          if (!f.locked_for_user) out.push(toFile(f, m.name));
        } catch (error) {
          if (![403, 404].includes((error as { status?: number }).status ?? 0)) throw error;
        }
      }
    }
    return out;
  }

  /** 下载课程文件：先读文件信息拿到带校验的下载地址，再用同一登录会话下载 */
  async downloadFile(fileId: string): Promise<DownloadedFile> {
    if (!/^\d+$/.test(fileId)) throw new Error('文件 id 不对，请用课件列表里返回的 id。');
    const info = await this.getObject<{ display_name?: string; filename?: string; size?: number; 'content-type'?: string; url?: string; locked_for_user?: boolean }>(`/files/${fileId}`);
    if (info.locked_for_user) throw new Error('这个文件还没开放，暂时不能下载。');
    if ((info.size ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 200 MB，请在 eLearning 网页上下载。');
    if (!info.url) throw new Error('eLearning 没有返回这个文件的下载地址，可能需要在网页上下载。');
    const res = await this.auth.fetch('elearning', info.url);
    if (!res.ok) throw Object.assign(new Error(`下载失败（${res.status}）`), { status: res.status });
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('文件超过 200 MB，请在 eLearning 网页上下载。');
    return { name: info.display_name ?? info.filename ?? `文件 ${fileId}`, contentType: info['content-type'] ?? res.headers.get('content-type') ?? undefined, data };
  }

  async listAnnouncements(courseIds: string[], since?: string): Promise<CanvasAnnouncement[]> {
    if (courseIds.length === 0) return [];
    type Raw = { id: number; context_code: string; title: string; message: string; posted_at: string; html_url: string };
    const params: Record<string, string | string[]> = { 'context_codes[]': courseIds.map((id) => `course_${id}`) };
    if (since) params.start_date = since;
    const raw = await this.get<Raw[]>('/announcements', params);
    return raw.map((a) => ({
      id: String(a.id),
      courseId: a.context_code.replace('course_', ''),
      title: a.title,
      message: a.message,
      postedAt: a.posted_at,
      htmlUrl: a.html_url,
    }));
  }
}
