import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CanvasClient } from '../src/services/elearning';
import { NeedLoginError, type FudanAuth } from '../src/core/fudan-auth';
import { findOp, type Ctx } from '../src/ops';
import { cacheTtl, runOp } from '../src/run';
import { mcpShape } from '../src/mcp';

const api = 'https://elearning.fudan.edu.cn/api/v1';
const json = (data: unknown, headers = {}, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
/** 按路径返回虚构数据；没列出的路径算 404 */
function setup(routes: Record<string, unknown>) {
  const fetch = vi.fn(async (_platform: string, url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v1', '');
    return path in routes ? json(routes[path]) : json({}, {}, 404);
  });
  return { client: new CanvasClient({ fetch } as unknown as FudanAuth), fetch };
}
const onlyGets = (fetch: ReturnType<typeof setup>['fetch']) => fetch.mock.calls.every(([, , init]) => !init?.method || init.method === 'GET');

describe('eLearning 成绩', () => {
  const groups = [
    { id: 2, name: '期末', position: 2, group_weight: 60, assignments: [] },
    { id: 1, name: '平时作业', position: 1, group_weight: 40, rules: { drop_lowest: 1 }, assignments: [
      { id: 20, name: '虚构作业一', due_at: '2026-11-01T15:59:00Z', points_possible: 10, html_url: 'https://example.com/a/20',
        submission: { score: 0, grade: '0', workflow_state: 'graded', late: true }, score_statistics: { min: 0, max: 10, mean: 7.5 } },
      { id: 21, name: '虚构作业二', points_possible: 10, submission: { score: null, grade: null, workflow_state: 'submitted' } },
      { id: 22, name: '虚构作业三', points_possible: null },
    ] },
  ];
  it('总评一次请求读完；没开放总评和不是学生的课分开表示，不编造零分', async () => {
    const { client, fetch } = setup({ '/users/self/enrollments': [
      { course_id: 10, grades: { current_score: 91.5, final_score: 60, current_grade: 'A-', final_grade: null, html_url: 'https://example.com/grades' } },
      { course_id: 11, grades: { html_url: 'https://example.com/grades/11' } },
      { course_id: 12, grades: null },
      { course_id: 12, grades: { current_score: 0, final_score: 0 } },
    ] });
    const totals = await client.listGradeTotals();
    expect(totals.get('10')).toEqual({ asStudent: true, currentScore: 91.5, currentGrade: 'A-', finalScore: 60, finalGrade: null, htmlUrl: 'https://example.com/grades' });
    expect(totals.get('11')).toMatchObject({ asStudent: true, currentScore: null, finalScore: null });
    expect(totals.get('12')).toMatchObject({ currentScore: 0, finalScore: 0 });
    expect(totals.has('13')).toBe(false);
    const query = new URL(fetch.mock.calls[0][1]);
    expect(query.searchParams.getAll('type[]')).toEqual(['StudentEnrollment']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('作业组按顺序返回权重和规则；零分、未评分、没有提交记录三种情况分得清', async () => {
    const { client, fetch } = setup({ '/courses/10': { id: 10, apply_assignment_group_weights: true }, '/courses/10/assignment_groups': groups });
    const result = await client.getCourseGrades('10');
    expect(result.weighted).toBe(true);
    expect(result.groups.map((g) => [g.name, g.weight, g.dropLowest])).toEqual([['平时作业', 40, 1], ['期末', 60, null]]);
    expect(result.groups[0].assignments).toMatchObject([
      { id: '20', score: 0, grade: '0', state: 'graded', late: true, pointsPossible: 10, stats: { min: 0, max: 10, mean: 7.5 } },
      { id: '21', score: null, grade: null, state: 'submitted', stats: null },
      { id: '22', score: null, state: null, pointsPossible: null },
    ]);
    const query = new URL(fetch.mock.calls.find(([, url]) => url.includes('assignment_groups'))![1]);
    expect(query.searchParams.getAll('include[]')).toEqual(['assignments', 'submission', 'score_statistics']);
    expect(onlyGets(fetch)).toBe(true);
  });
  it('课程没返回加权设置时为 null；格式异常、无权限、登录过期如实报错', async () => {
    expect((await setup({ '/courses/10': { id: 10 }, '/courses/10/assignment_groups': [] }).client.getCourseGrades('10'))).toEqual({ weighted: null, groups: [] });
    await expect(setup({ '/courses/10': { id: 10 }, '/courses/10/assignment_groups': [{ id: 1, name: null }] }).client.getCourseGrades('10')).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    await expect(setup({ '/users/self/enrollments': [{ grades: {} }] }).client.listGradeTotals()).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    await expect(setup({}).client.getCourseGrades('10')).rejects.toMatchObject({ code: 'NOT_FOUND', hint: expect.any(String) });
    const denied = new CanvasClient({ fetch: vi.fn(async () => json({}, {}, 403)) } as unknown as FudanAuth);
    await expect(denied.getCourseGrades('10')).rejects.toMatchObject({ code: 'PERMISSION' });
    const expired = new CanvasClient({ fetch: vi.fn(async () => json({}, {}, 401)) } as unknown as FudanAuth);
    await expect(expired.listGradeTotals()).rejects.toBeInstanceOf(NeedLoginError);
    const invalid = vi.fn();
    await expect(new CanvasClient({ fetch: invalid } as unknown as FudanAuth).getCourseGrades('../users')).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(invalid).not.toHaveBeenCalled();
  });
});

describe('eLearning 讨论区', () => {
  const topic = { id: 30, title: '虚构答疑帖', message: '<p>第一题怎么做？<script>secret()</script></p>', html_url: 'https://example.com/t/30', posted_at: '2026-11-10T02:00:00Z', last_reply_at: '2026-11-11T02:00:00Z', discussion_subentry_count: 3, unread_count: 1, read_state: 'unread', author: { display_name: '虚构助教' }, pinned: true, locked: false };
  const view = {
    participants: [{ id: 1, display_name: '虚构同学甲' }, { id: 2, display_name: '虚构助教' }, { id: null, display_name: null }],
    unread_entries: [42],
    view: [
      { id: 40, user_id: 1, parent_id: null, created_at: '2026-11-10T03:00:00Z', message: '<p>我也不会</p>', replies: [
        { id: 41, user_id: 2, parent_id: 40, message: '<p>看讲义第 3 页<br>再试试</p>', attachment: { id: 60, display_name: '提示.pdf', url: 'https://example.com/f/60' }, replies: [
          { id: 42, user_id: 99, parent_id: 41, message: '谢谢' },
        ] },
      ] },
      { id: 43, user_id: 1, deleted: true },
    ],
  };
  it('主题列表读出标题、发帖人、纯文本正文和未读数；脚本不进正文', async () => {
    const { client, fetch } = setup({ '/courses/10/discussion_topics': [topic, { id: 31, title: '虚构锁定帖', message: '不该展示', locked_for_user: true, lock_explanation: '下周开放', user_name: '虚构教师' }] });
    const list = await client.listDiscussions('10');
    expect(list).toMatchObject([
      { id: '30', title: '虚构答疑帖', author: '虚构助教', text: '第一题怎么做？', replies: 3, unread: 1, readState: 'unread', pinned: true },
      { id: '31', author: '虚构教师', lockedForUser: true, lockExplanation: '下周开放', text: null },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('回帖保持树状、对上发帖人和未读标记；已删除的回帖不带正文；只发 GET', async () => {
    const { client, fetch } = setup({ '/courses/10/discussion_topics/30': topic, '/courses/10/discussion_topics/30/view': view });
    const result = await client.getDiscussion('10', '30');
    expect(result).toMatchObject({ id: '30', entriesCount: 4, entries: [
      { id: '40', author: '虚构同学甲', text: '我也不会', unread: false, replies: [
        { id: '41', parentId: '40', author: '虚构助教', text: '看讲义第 3 页\n再试试', attachments: [{ id: '60', name: '提示.pdf' }], replies: [
          { id: '42', author: null, text: '谢谢', unread: true, replies: [] },
        ] },
      ] },
      { id: '43', deleted: true, text: null },
    ] });
    expect(fetch.mock.calls.map(([, url]) => new URL(url).pathname).sort()).toEqual(['/api/v1/courses/10/discussion_topics/30', '/api/v1/courses/10/discussion_topics/30/view']);
    expect(onlyGets(fetch)).toBe(true);
  });
  it('要求先发帖（403）、主题不存在、格式异常、id 不对都有明确错误', async () => {
    const denied = new CanvasClient({ fetch: vi.fn(async () => json({}, {}, 403)) } as unknown as FudanAuth);
    await expect(denied.getDiscussion('10', '30')).rejects.toMatchObject({ code: 'PERMISSION', hint: expect.stringContaining('先在网页上发帖') });
    await expect(setup({}).client.listDiscussions('10')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setup({ '/courses/10/discussion_topics/30': topic, '/courses/10/discussion_topics/30/view': { view: [{ id: 'x' }] } }).client.getDiscussion('10', '30')).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    const invalid = vi.fn();
    await expect(new CanvasClient({ fetch: invalid } as unknown as FudanAuth).getDiscussion('10', '30/view?x=1')).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(invalid).not.toHaveBeenCalled();
  });
});

describe('eLearning 站内信', () => {
  const conversation = { id: 70, subject: '虚构答疑安排', workflow_state: 'unread', last_message: '周三下午答疑', last_message_at: '2026-11-12T08:00:00Z', message_count: 2, starred: false, context_name: '虚构课程', participants: [{ id: 1, name: '虚构学生' }, { id: 2, name: '虚构教师' }] };
  it('列表按分类读取并在达到数量后停止翻页', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([conversation, { ...conversation, id: 71 }], { Link: `<${api}/conversations?page=2>; rel="next"` }));
    const list = await new CanvasClient({ fetch } as unknown as FudanAuth).listConversations('unread', 2);
    expect(list).toMatchObject([{ id: '70', subject: '虚构答疑安排', state: 'unread', lastMessage: '周三下午答疑', context: '虚构课程', participants: ['虚构学生', '虚构教师'] }, { id: '71' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const query = new URL(fetch.mock.calls[0][1]);
    expect([query.searchParams.get('scope'), query.searchParams.get('per_page')]).toEqual(['unread', '2']);
  });
  it('读取会话时明确关闭自动标已读，消息对上发件人和附件', async () => {
    const { client, fetch } = setup({ '/conversations/70': { ...conversation, messages: [
      { id: 81, created_at: '2026-11-12T08:00:00Z', body: '周三下午答疑', author_id: 2, generated: false, attachments: [{ id: 90, display_name: '安排.pdf', size: 10, 'content-type': 'application/pdf', url: 'https://example.com/f/90' }] },
      { id: 80, created_at: '2026-11-11T08:00:00Z', body: '老师好', author_id: 1 },
    ] } });
    expect(await client.getConversation('70')).toMatchObject({ id: '70', state: 'unread', messages: [
      { id: '81', author: '虚构教师', text: '周三下午答疑', attachments: [{ id: '90', name: '安排.pdf', contentType: 'application/pdf' }] },
      { id: '80', author: '虚构学生', attachments: [] },
    ] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(fetch.mock.calls[0][1]).searchParams.get('auto_mark_as_read')).toBe('false');
    expect(onlyGets(fetch)).toBe(true);
  });
  it('返回了别的会话、缺消息列表、会话不存在、id 不对都报错', async () => {
    await expect(setup({ '/conversations/70': { ...conversation, id: 71, messages: [] } }).client.getConversation('70')).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    await expect(setup({ '/conversations/70': conversation }).client.getConversation('70')).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    await expect(setup({}).client.getConversation('70')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const invalid = vi.fn();
    await expect(new CanvasClient({ fetch: invalid } as unknown as FudanAuth).getConversation('70?auto_mark_as_read=true')).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(invalid).not.toHaveBeenCalled();
  });
});

describe('CLI 与 MCP：成绩、讨论区、站内信', () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { session: {} } as unknown as Ctx;
  const course = { id: '10', name: '虚构课程', courseCode: 'TEST001', teachers: [] };
  const totals = { asStudent: true, currentScore: 90, currentGrade: null, finalScore: 80, finalGrade: null, htmlUrl: null };
  it('grades：不传课程只返回各门课总评；传课程才读作业组，关键词不唯一时不读', async () => {
    vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course, { ...course, id: '11', name: '虚构课程二' }]);
    vi.spyOn(CanvasClient.prototype, 'listGradeTotals').mockResolvedValue(new Map([['10', totals]]));
    const detail = vi.spyOn(CanvasClient.prototype, 'getCourseGrades').mockResolvedValue({ weighted: true, groups: [] });
    const op = findOp('elearning.grades')!;
    expect(await runOp(op, ctx, {})).toMatchObject({ ok: true, data: [
      { courseId: '10', course: '虚构课程', asStudent: true, currentScore: 90 },
      { courseId: '11', asStudent: false, currentScore: null, finalScore: null },
    ] });
    expect(detail).not.toHaveBeenCalled();
    expect(await runOp(op, ctx, { course: '虚构' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(detail).not.toHaveBeenCalled();
    expect(await runOp(op, ctx, { course: '10' })).toMatchObject({ ok: true, data: [{ courseId: '10', currentScore: 90, weighted: true, groups: [] }] });
    expect(detail).toHaveBeenCalledWith('10');
  });
  it('discussions 和 inbox：列表与单条分开，参数冲突时不发请求', async () => {
    vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course]);
    vi.spyOn(CanvasClient.prototype, 'listDiscussions').mockResolvedValue([{ id: '30', postedAt: '2026-11-10T02:00:00Z', lastReplyAt: null } as never]);
    vi.spyOn(CanvasClient.prototype, 'getDiscussion').mockResolvedValue({ id: '30', postedAt: null, entries: [] } as never);
    const list = vi.spyOn(CanvasClient.prototype, 'listConversations').mockResolvedValue([]);
    const read = vi.spyOn(CanvasClient.prototype, 'getConversation').mockResolvedValue({ id: '70', lastMessageAt: null, messages: [] } as never);
    expect(await runOp(findOp('elearning.discussions')!, ctx, { course: '10' })).toMatchObject({ ok: true, data: { courseId: '10', topics: [{ id: '30', postedAtShanghai: expect.stringContaining('2026/11/10') }] } });
    expect(await runOp(findOp('elearning.discussions')!, ctx, { course: '10', topic: '30' })).toMatchObject({ ok: true, data: { topic: { id: '30', entries: [] } } });
    expect(await runOp(findOp('elearning.discussions')!, ctx, { course: '10', topic: 'abc' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    const inbox = findOp('elearning.inbox')!;
    expect(await runOp(inbox, ctx, { conversation: '70', scope: 'sent' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(await runOp(inbox, ctx, { scope: 'drafts' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(read).not.toHaveBeenCalled();
    expect(await runOp(inbox, ctx, { scope: 'unread', limit: '5' })).toMatchObject({ ok: true, data: { scope: 'unread', conversations: [] } });
    expect(list).toHaveBeenCalledWith('unread', 5);
    expect(await runOp(inbox, ctx, { conversation: '70' })).toMatchObject({ ok: true, data: { conversation: { id: '70' } } });
  });
  it('三个命令都只读；成绩和站内信按隐私数据缓存；参数能用于 MCP', () => {
    for (const name of ['elearning.grades', 'elearning.discussions', 'elearning.inbox']) expect(findOp(name)!.effect).toBe('read');
    expect([findOp('elearning.grades')!.sensitive, findOp('elearning.inbox')!.sensitive, findOp('elearning.discussions')!.sensitive]).toEqual([true, true, undefined]);
    expect(cacheTtl(findOp('elearning.grades')!)).toBe(cacheTtl(findOp('jw.grades')!));
    expect(z.object(mcpShape(findOp('elearning.inbox')!)).safeParse({ scope: 'starred', limit: 10 }).success).toBe(true);
    expect(z.object(mcpShape(findOp('elearning.discussions')!)).safeParse({ course: '10', topic: '30' }).success).toBe(true);
  });
});
