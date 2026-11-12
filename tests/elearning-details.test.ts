import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CanvasClient } from '../src/services/elearning';
import { NeedLoginError, type FudanAuth } from '../src/core/fudan-auth';
import { cacheTtl, runOp } from '../src/run';
import { findOp, type Ctx } from '../src/ops';
import { mcpShape, toolDescription } from '../src/mcp';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const assignment = { id: 20, course_id: 10, name: '虚构实验', description: '<p>实验说明</p>', html_url: 'https://example.com/assignment/20', submission_types: ['online_upload'], points_possible: 100, due_at: '2026-11-20T15:59:00Z', allowed_attempts: -1, allowed_extensions: ['pdf'] };
const submission = {
  id: 30, assignment_id: 20, workflow_state: 'graded', attempt: 2, submission_type: 'online_upload',
  submitted_at: '2026-11-12T01:00:00Z', graded_at: '2026-11-12T02:00:00Z', score: 0, grade: '0', grade_matches_current_submission: false,
  attachments: [{ id: 40, display_name: '虚构报告.pdf', filename: 'report.pdf', size: 1234, 'content-type': 'application/pdf', url: 'https://example.com/files/40' }],
  submission_comments: [{ id: 50, author_name: '虚构教师', comment: '请补充实验过程', created_at: '2026-11-12T02:01:00Z', attachments: [] }],
  submission_history: [{ id: 30, assignment_id: 20, workflow_state: 'submitted', attempt: 1, submission_type: 'online_url', url: 'https://example.com/project', submitted_at: '2026-11-11T01:00:00Z' }],
};
function setup(over: { assignment?: unknown; submission?: unknown; status?: number; complete?: boolean } = {}) {
  const fetch = vi.fn(async (_platform: string, url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/submissions/self')) return json(over.submission ?? submission, over.status ?? 200);
    if (path.endsWith('/planner/overrides')) return json(over.complete ? [{ plannable_type: 'assignment', plannable_id: 20, marked_complete: true }] : []);
    if (path.endsWith('/modules')) return json([]);
    return json(over.assignment ?? assignment);
  });
  return { client: new CanvasClient({ fetch } as unknown as FudanAuth), fetch };
}

describe('单份作业及本人提交详情', () => {
  it('读取当前提交、附件、旧提交、评语；保留零分和分数不对应当前提交的标记', async () => {
    const { client, fetch } = setup();
    const result = await client.getAssignment('10', '20');
    expect(result).toMatchObject({ id: '20', courseId: '10', submitted: true, pointsPossible: 100, allowedAttempts: -1, allowedExtensions: ['pdf'], submission: {
      id: '30', state: 'graded', attempt: 2, score: 0, grade: '0', gradeMatchesCurrentSubmission: false,
      attachments: [{ id: '40', name: '虚构报告.pdf', size: 1234, contentType: 'application/pdf', url: 'https://example.com/files/40' }],
      comments: [{ id: '50', author: '虚构教师', text: '请补充实验过程' }],
      history: [{ attempt: 1, submissionType: 'online_url', url: 'https://example.com/project' }],
    } });
    const query = new URL(fetch.mock.calls.find(([, url]) => url.includes('/submissions/'))![1]);
    expect(query.pathname).toBe('/api/v1/courses/10/assignments/20/submissions/self');
    expect(query.searchParams.getAll('include[]')).toEqual(['submission_comments', 'submission_history']);
    expect(fetch.mock.calls.every(([, url, init]) => !url.includes('read_status') && (!init?.method || init.method === 'GET'))).toBe(true);
  });
  it('未提交、未评分和接口未返回评语/历史均如实返回，不编造零分或空评语', async () => {
    const { client } = setup({ submission: { assignment_id: '20', id: null, workflow_state: 'unsubmitted', attempt: null, score: null, grade: null } });
    expect(await client.getAssignment('10', '20')).toMatchObject({ submitted: false, submission: {
      id: null, state: 'unsubmitted', attempt: null, score: null, grade: null, attachments: [], comments: null, history: null,
    } });
    const empty = setup({ submission: { ...submission, submission_comments: [], submission_history: [] } });
    expect((await empty.client.getAssignment('10', '20')).submission).toMatchObject({ comments: [], history: [] });
  });
  it('文本提交的 HTML 原样保留；本人未提交但已勾选完成仍标记完成', async () => {
    const { client } = setup({ complete: true, submission: { ...submission, workflow_state: 'unsubmitted', body: '<p>虚构答案</p>', submission_type: 'online_text_entry' } });
    expect(await client.getAssignment('10', '20')).toMatchObject({ submitted: false, markedDone: true, submission: { body: '<p>虚构答案</p>', submissionType: 'online_text_entry' } });
  });
  it.each([
    { assignment: { ...assignment, id: 21 } },
    { assignment: { ...assignment, course_id: 11 } },
    { assignment: { ...assignment, name: null } },
    { submission: { ...submission, assignment_id: 21 } },
    { submission: { ...submission, attempt: -1 } },
    { submission: { ...submission, score: '100' } },
    { submission: { ...submission, attachments: [{ id: null }] } },
    { submission: { ...submission, submission_history: [{ ...submission, assignment_id: 21 }] } },
  ])('拒绝错配或畸形接口数据：%j', async (over) => {
    await expect(setup(over).client.getAssignment('10', '20')).rejects.toMatchObject({ code: 'FORMAT_CHANGED', hint: expect.any(String) });
  });
  it('404 有可操作提示；403 和 401 保留权限/认证语义', async () => {
    await expect(setup({ status: 404 }).client.getAssignment('10', '20')).rejects.toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('--assignment') });
    await expect(setup({ status: 403 }).client.getAssignment('10', '20')).rejects.toMatchObject({ status: 403 });
    await expect(setup({ status: 401 }).client.getAssignment('10', '20')).rejects.toBeInstanceOf(NeedLoginError);
  });
  it('无效 id 不发送网络请求', async () => {
    const { client, fetch } = setup();
    await expect(client.getAssignment('../users', '20')).rejects.toMatchObject({ code: 'BAD_ARGS' });
    await expect(client.getAssignment('10', '0')).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('现有 assignments 命令的详情参数', () => {
  afterEach(() => vi.restoreAllMocks());
  const op = findOp('elearning.assignments')!;
  const course = { id: '10', name: '虚构课程', courseCode: 'TEST001', teachers: [] };
  const ctx = { session: {}, now: () => 0 } as unknown as Ctx;
  it('列表模式不读取提交详情，保留数组输出和原字段', async () => {
    vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course]);
    vi.spyOn(CanvasClient.prototype, 'listAssignments').mockResolvedValue([{ id: '20', courseId: '10', name: '虚构作业', htmlUrl: 'https://example.com', submitted: false, submissionTypes: ['online_url'] }]);
    const detail = vi.spyOn(CanvasClient.prototype, 'getAssignment');
    expect(await runOp(op, ctx, {})).toMatchObject({ ok: true, data: [{ id: '20', course: course.name, done: false }] });
    expect(detail).not.toHaveBeenCalled();
  });
  it('详情模式只返回选定作业，仍是数组；支持 MCP 字符串参数和隐私提示', async () => {
    vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course]);
    const detail = await setup().client.getAssignment('10', '20');
    vi.spyOn(CanvasClient.prototype, 'getAssignment').mockResolvedValue(detail);
    expect(await runOp(op, ctx, { course: '10', assignment: '20' })).toMatchObject({ ok: true, data: [{ id: '20', course: course.name, done: true, dueAtShanghai: expect.any(String), submission: { attempt: 2 } }] });
    expect(CanvasClient.prototype.getAssignment).toHaveBeenCalledWith('10', '20');
    expect(z.object(mcpShape(op)).safeParse({ course: '10', assignment: '20' }).success).toBe(true);
    expect(op.sensitive).toBe(true);
    expect(cacheTtl(op)).toBe(24 * 3_600_000);
    expect(toolDescription(op)).toContain('隐私');
  });
  it('缺少课程或与 pending 同用时在联网前报参数错误；课程歧义不读取详情', async () => {
    const courses = vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course, { ...course, id: '11' }]);
    const detail = vi.spyOn(CanvasClient.prototype, 'getAssignment');
    for (const args of [{ assignment: '20' }, { assignment: '20', course: '10', pending: true }]) {
      expect(await runOp(op, ctx, args)).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    }
    expect(courses).not.toHaveBeenCalled();
    expect(await runOp(op, ctx, { assignment: '20', course: '虚构' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(detail).not.toHaveBeenCalled();
  });
});
