import { extname } from 'node:path';
import { FduError } from '../core/errors';
import { isPermissionDenied, isUisLoginUrl, NeedLoginError, PLATFORM_URLS, type FudanAuth } from '../core/fudan-auth';

export const MAX_SUBMISSION_BYTES = 200 * 1024 * 1024;
export interface SubmissionInput {
  file?: { name: string; data: Uint8Array };
  text?: string;
  url?: string;
  dryRun?: boolean;
  resubmit?: boolean;
}
interface Assignment {
  id: number | string; course_id: number | string; name: string; html_url: string;
  submission_types: string[]; allowed_extensions?: string[];
  locked_for_user?: boolean; unlock_at?: string | null; lock_at?: string | null; due_at?: string | null;
  published?: boolean; allowed_attempts?: number; group_category_id?: number | null;
}
interface Submission {
  id: number | string; assignment_id: number | string; attempt?: number | null;
  workflow_state: string; submitted_at?: string | null; submission_type?: string;
  body?: string; url?: string; attachments?: { id: number | string }[]; excused?: boolean;
}
const done = (s: Submission) => ['submitted', 'graded', 'pending_review'].includes(s.workflow_state);
const numericId = (v: unknown): v is string | number => typeof v === 'number' ? Number.isSafeInteger(v) && v > 0 : typeof v === 'string' && /^[1-9]\d*$/.test(v);
const bad = (message: string) => new FduError('BAD_ARGS', message, '用 `fdu elearning assignments --course <课程>` 核对作业，或打开作业网页查看要求。');

/** 仅参考 Canvas 公开协议；所有网络请求通过注入的认证接口，写请求不重试。 */
export class CanvasSubmitClient {
  private readonly base = PLATFORM_URLS.elearning.base;
  constructor(private readonly auth: FudanAuth) {}

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.auth.fetch('elearning', url, init);
    if (isUisLoginUrl(res.url)) throw new NeedLoginError('elearning');
    if (res.status === 401 && !(await isPermissionDenied(res))) throw new NeedLoginError('elearning');
    if ([401, 403].includes(res.status)) throw new FduError('PERMISSION', 'eLearning 拒绝了请求（权限不足或 CSRF 会话失效）。', '运行 `fdu login`，并在作业网页确认你可以提交。');
    if (res.status === 404) throw new FduError('NOT_FOUND', '没有找到课程或作业。', '用 `fdu elearning assignments` 查询正确的 id。');
    if ([400, 422].includes(res.status)) throw bad('eLearning 拒绝了提交参数，请在作业网页核对提交类型、文件格式和剩余次数。');
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new FduError('UPSTREAM', `eLearning 未返回有效接口数据（HTTP ${res.status}）。`, '打开作业网页查看状态。');
    return res.json() as Promise<T>;
  }

  private async post<T>(url: string, body: unknown): Promise<T> {
    if (!this.auth.csrfToken) throw new FduError('INTERNAL', '认证适配器不支持网页提交。', '使用 fdu 自带的登录会话。');
    const csrf = await this.auth.csrfToken('elearning');
    return this.json<T>(url, { method: 'POST', redirect: 'manual', headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf,
      'X-Requested-With': 'XMLHttpRequest', Origin: this.base, Referer: `${this.base}/`,
    }, body: JSON.stringify(body) });
  }

  private checkSubmission(s: Submission, assignmentId: string): void {
    if (!s || !numericId(s.id) || String(s.assignment_id) !== assignmentId || typeof s.workflow_state !== 'string'
      || (s.attempt != null && (!Number.isSafeInteger(s.attempt) || s.attempt < 0))) {
      throw new FduError('FORMAT_CHANGED', 'eLearning 提交记录格式异常。', '打开作业网页核对提交记录。');
    }
  }

  private async upload(path: string, file: NonNullable<SubmissionInput['file']>): Promise<string> {
    const ticket = await this.post<{ upload_url: string; upload_params: Record<string, unknown> }>(`${path}/submissions/self/files`, {
      name: file.name, size: file.data.byteLength, on_duplicate: 'rename',
    });
    let target: URL;
    try { target = new URL(ticket.upload_url); } catch { throw new FduError('FORMAT_CHANGED', 'eLearning 返回了异常上传地址。', '请在网页上传文件。'); }
    if (target.protocol !== 'https:' || target.username || target.password || !ticket.upload_params || typeof ticket.upload_params !== 'object' || Array.isArray(ticket.upload_params)) {
      throw new FduError('FORMAT_CHANGED', 'eLearning 返回了异常上传参数。', '请在网页上传文件。');
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.upload_params)) {
      if (key === 'file' || !['string', 'number', 'boolean'].includes(typeof value)) throw new FduError('FORMAT_CHANGED', 'eLearning 上传参数格式异常。', '请在网页上传文件。');
      form.append(key, String(value));
    }
    // 协议要求文件排在所有签名字段之后；跨域存储不发送 CSRF 或 Authorization。
    form.append('file', new Blob([new Uint8Array(file.data)]), file.name);
    const headers: Record<string, string> = {};
    if (target.origin === this.base && this.auth.csrfToken) {
      headers['X-CSRF-Token'] = await this.auth.csrfToken('elearning');
      headers['X-Requested-With'] = 'XMLHttpRequest';
      headers.Origin = this.base;
      headers.Referer = `${this.base}/`;
    }
    const response = await this.auth.fetch('elearning', target.href, { method: 'POST', redirect: 'manual', headers, body: form });
    let uploaded: { id?: unknown };
    const location = response.headers.get('location');
    if ((response.status >= 300 && response.status < 400) || (response.status === 201 && location)) {
      const finish = new URL(location ?? '', target);
      if (!location || finish.origin !== this.base || !finish.pathname.startsWith('/api/v1/files/') || finish.username || finish.password) {
        throw new FduError('FORMAT_CHANGED', 'eLearning 返回了异常上传确认地址。', '请在网页检查文件；尚未发送作业提交请求。');
      }
      uploaded = await this.json(finish.href, { redirect: 'manual' });
    } else {
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new FduError('UPSTREAM', '文件上传失败，尚未发送作业提交请求。', '在网页检查文件；重新运行命令可能产生另一份上传文件。');
      uploaded = await response.json() as { id?: unknown };
    }
    if (!numericId(uploaded?.id)) throw new FduError('FORMAT_CHANGED', '上传结果缺少文件 id，尚未发送作业提交请求。', '请在网页检查文件。');
    return String(uploaded.id);
  }

  async submit(courseId: string, assignmentId: string, input: SubmissionInput, now = Date.now()) {
    if (!numericId(courseId) || !numericId(assignmentId)) throw bad('课程和作业 id 必须为正整数。');
    if ([input.file, input.text, input.url].filter((x) => x !== undefined).length !== 1) throw bad('必须且只能提供 --file、--text、--url 中的一种。');
    const type = input.file ? 'online_upload' : input.text !== undefined ? 'online_text_entry' : 'online_url';
    if (input.text !== undefined && !input.text.trim()) throw bad('提交文本不能为空。');
    if (input.url !== undefined) {
      let u: URL;
      try { u = new URL(input.url); } catch { throw bad('网址必须是完整的 HTTP / HTTPS 地址。'); }
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw bad('网址必须是 HTTP / HTTPS 地址，不能包含账号密码。');
    }
    if (input.file && (!input.file.data.byteLength || input.file.data.byteLength > MAX_SUBMISSION_BYTES)) throw bad('文件不能为空，单个文件不能超过 200 MB。');
    const path = `${this.base}/api/v1/courses/${courseId}/assignments/${assignmentId}`;
    const assignment = await this.json<Assignment>(path);
    if (!assignment || String(assignment.id) !== assignmentId || String(assignment.course_id) !== courseId || !Array.isArray(assignment.submission_types)) {
      throw new FduError('FORMAT_CHANGED', 'eLearning 作业信息格式异常。', '请打开作业网页核对。');
    }
    if (!assignment.submission_types.includes(type)) throw bad('该作业不接受这种提交方式。');
    if (assignment.published === false || assignment.locked_for_user || (assignment.unlock_at && Date.parse(assignment.unlock_at) > now) || (assignment.lock_at && Date.parse(assignment.lock_at) <= now)) throw bad('该作业尚未开放或已关闭提交。');
    if (input.file && assignment.allowed_extensions?.length) {
      const extension = extname(input.file.name).slice(1).toLowerCase();
      if (!assignment.allowed_extensions.some((e) => e.replace(/^\./, '').toLowerCase() === extension)) throw bad(`该作业只接受：${assignment.allowed_extensions.join('、')}。`);
    }
    const before = await this.json<Submission>(`${path}/submissions/self`);
    this.checkSubmission(before, assignmentId);
    const previousAttempt = before.attempt ?? 0;
    if (before.excused) throw bad('该作业已免交，请在网页核对是否需要提交。');
    if (assignment.allowed_attempts !== undefined && assignment.allowed_attempts >= 0 && previousAttempt >= assignment.allowed_attempts) throw bad('该作业已用完允许的提交次数。');
    const alreadySubmitted = done(before) || !!before.submitted_at || previousAttempt > 0;
    if (alreadySubmitted && !input.resubmit && !input.dryRun) throw bad('已有提交记录；确认要重新提交时加 --resubmit（会占用一次提交机会）。');
    const plan = {
      courseId, assignmentId, assignment: assignment.name, htmlUrl: assignment.html_url, submissionType: type,
      previousAttempt, alreadySubmitted, groupAssignment: !!assignment.group_category_id,
      dueAt: assignment.due_at ?? null, late: !!assignment.due_at && Date.parse(assignment.due_at) < now,
      ...(input.file ? { file: { name: input.file.name, bytes: input.file.data.byteLength } } : input.text !== undefined ? { text: input.text } : { url: input.url }),
    };
    if (input.dryRun) return { dryRun: true, ...plan };
    const fileId = input.file ? await this.upload(path, input.file) : undefined;
    const submission = { submission_type: type, ...(fileId ? { file_ids: [fileId] } : input.text !== undefined ? { body: input.text } : { url: input.url }) };
    // 只发一次 POST；无论请求超时还是后续核验失败，都不能让执行器自动重跑整个上传/提交流程。
    let accepted: Submission | undefined;
    let postError: unknown;
    try {
      accepted = await this.post<Submission>(`${path}/submissions`, { submission });
      this.checkSubmission(accepted, assignmentId);
    } catch (e) {
      if (e instanceof FduError && ['BAD_ARGS', 'PERMISSION', 'NOT_FOUND'].includes(e.code)) throw e;
      postError = e;
    }
    try {
      const after = await this.json<Submission>(`${path}/submissions/self`);
      this.checkSubmission(after, assignmentId);
      const matches = fileId ? after.attachments?.length === 1 && String(after.attachments[0].id) === fileId
        : input.text !== undefined ? after.body === input.text : after.url === input.url;
      // POST 成功时以返回的提交记录和 attempt 核验；网络异常时必须同时核对内容，不能把旧提交当成功。
      const receiptMatches = accepted && String(after.id) === String(accepted.id) && after.attempt === accepted.attempt && !postError;
      if (done(after) && after.submitted_at && (after.attempt ?? 0) > previousAttempt && after.submission_type === type
        && (fileId ? matches : receiptMatches || matches)) {
        return { dryRun: false, ...plan, verified: true, submission: { id: String(after.id), attempt: after.attempt, state: after.workflow_state, submittedAt: after.submitted_at, ...(fileId ? { fileId } : {}) } };
      }
    } catch { /* 发送后无法核验：保留不确定结果，绝不自动重发 */ }
    throw new FduError('SUBMISSION_UNKNOWN', '已尝试发送作业提交，但无法确认结果；没有自动重试。', `请打开 ${assignment.html_url || `${this.base}/courses/${courseId}/assignments/${assignmentId}`} 查看最新提交、附件和次数，确认后再决定是否重交。`);
  }
}
