import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CanvasClient } from '../src/services/elearning';
import { NeedLoginError, type FudanAuth } from '../src/core/fudan-auth';
import { findOp, type Ctx } from '../src/ops';
import { runOp } from '../src/run';
import { mcpShape } from '../src/mcp';

const base = 'https://elearning.fudan.edu.cn/api/v1/courses/10';
const json = (data: unknown, headers = {}, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const item = { id: 30, module_id: 20, title: '虚构实验说明', type: 'Page', position: 1, indent: 1, page_url: 'lab-guide' };
const module = { id: 20, name: '虚构第一单元', position: 1, items_count: 1, items: [item] };
const page = { page_id: 40, title: '虚构实验说明', url: 'lab-guide', html_url: 'https://elearning.fudan.edu.cn/courses/10/pages/lab-guide', published: true, locked_for_user: false };
const client = (fetch: ReturnType<typeof vi.fn>) => new CanvasClient({ fetch } as unknown as FudanAuth);

describe('课程单元读取', () => {
  it('保留顺序、缩进、类型和锁定信息，只读取元数据，不跟随条目和外部地址', async () => {
    const fetch = vi.fn().mockResolvedValue(json([{ ...module, items_count: 3, items: [
      { ...item, content_details: { locked_for_user: true, lock_explanation: '下周开放', unlock_at: '2026-11-20T00:00:00Z' } },
      { ...item, id: 31, type: 'File', content_id: 50, page_url: null },
      { ...item, id: 32, type: 'ExternalUrl', external_url: 'https://example.com/read' },
    ] }]));
    expect(await client(fetch).listModules('10')).toMatchObject([{ id: '20', itemsCount: 3, visibleItemsCount: 3, items: [
      { id: '30', type: 'Page', pageUrl: 'lab-guide', indent: 1, lockedForUser: true, lockExplanation: '下周开放' },
      { id: '31', type: 'File', contentId: '50' },
      { id: '32', type: 'ExternalUrl', externalUrl: 'https://example.com/read' },
    ] }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(fetch.mock.calls[0][1]).searchParams.getAll('include[]')).toEqual(['items', 'content_details']);
  });
  it('省略或不完整的内联条目会另查，完整读取单元及条目的分页，不信任 items_url', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([{ ...module, items: undefined, items_count: 2, items_url: 'https://evil.example/items' }], { Link: `<${base}/modules?page=2>; rel="next"` }))
      .mockResolvedValueOnce(json([{ id: 21, name: '空单元', items_count: 0, items: [] }]))
      .mockResolvedValueOnce(json([item], { Link: `<${base}/modules/20/items?page=2>; rel="next"` }))
      .mockResolvedValueOnce(json([{ ...item, id: 31, position: 2 }]));
    const rows = await client(fetch).listModules('10');
    expect(rows.map((m) => [m.id, m.items.length])).toEqual([['20', 2], ['21', 0]]);
    expect(fetch.mock.calls.every(([, url]) => url.startsWith(base))).toBe(true);
    const partial = vi.fn().mockResolvedValueOnce(json([{ ...module, items_count: 2 }])).mockResolvedValueOnce(json([item, { ...item, id: 31 }]));
    expect((await client(partial).listModules('10'))[0].items).toHaveLength(2);
  });
  it('单元总数和当前可见条目数分别返回，不补造不可见内容', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([{ ...module, items_count: 2, items: null }])).mockResolvedValueOnce(json([item]));
    expect(await client(fetch).listModules('10')).toMatchObject([{ itemsCount: 2, visibleItemsCount: 1 }]);
  });
  it('拒绝条目所属单元错配和异常分页，不能返回看似完整的结果', async () => {
    const wrong = vi.fn().mockResolvedValue(json([{ ...module, items: [{ ...item, module_id: 999 }] }]));
    await expect(client(wrong).listModules('10')).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    const badLink = vi.fn().mockResolvedValue(json([module], { Link: '<https://evil.example/modules>; rel="next"' }));
    await expect(client(badLink).listModules('10')).rejects.toThrow('分页');
    expect(badLink).toHaveBeenCalledTimes(1);
  });
});

describe('课程页面读取', () => {
  it('页面列表完整分页，按标题搜索，不请求正文', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json([page], { Link: `<${base}/pages?page=2>; rel="next"` })).mockResolvedValueOnce(json([{ ...page, page_id: 41, url: 'week-2' }]));
    expect((await client(fetch).listPages('10', '实验')).map((p) => p.id)).toEqual(['40', '41']);
    const query = new URL(fetch.mock.calls[0][1]);
    expect(query.searchParams.get('search_term')).toBe('实验');
    expect(query.searchParams.has('include[]')).toBe(false);
  });
  it('返回原始 HTML、可读文本和解析后的链接；不执行脚本、不请求任何链接', async () => {
    const body = '<h1>实验一</h1><p>任务 A<br>任务 B</p><a href="/courses/10/files/50">讲义</a><a href="https://example.com/read">阅读</a><a href="javascript:alert(1)">坏链接</a><script>secret()</script>';
    const fetch = vi.fn().mockResolvedValue(json({ ...page, body }));
    const result = await client(fetch).getPage('10', 'lab-guide');
    expect(result.body).toBe(body);
    expect(result.text).toContain('任务 A\n任务 B');
    expect(result.text).not.toContain('secret()');
    expect(result.links).toEqual([{ title: '讲义', url: 'https://elearning.fudan.edu.cn/courses/10/files/50' }, { title: '阅读', url: 'https://example.com/read' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toBe(`${base}/pages/lab-guide`);
    expect(fetch.mock.calls[0][2]).toEqual({ headers: { Accept: 'application/json' } });
  });
  it('锁定页面仅返回元数据和说明；空正文和未返回正文区分开', async () => {
    const locked = await client(vi.fn().mockResolvedValue(json({ ...page, locked_for_user: true, lock_explanation: '未开放', body: '不能展示' }))).getPage('10', 'lab-guide');
    expect(locked).toMatchObject({ lockedForUser: true, lockExplanation: '未开放', body: null, text: null, links: [] });
    expect(await client(vi.fn().mockResolvedValue(json({ ...page, body: '' }))).getPage('10', 'lab-guide')).toMatchObject({ body: '', text: '' });
    expect(await client(vi.fn().mockResolvedValue(json(page))).getPage('10', 'lab-guide')).toMatchObject({ body: null, text: null });
  });
  it('中文标识和显式数字 id 正确编码；阻止路径和查询注入', async () => {
    const fetch = vi.fn(async (_platform: string, _url: string) => json(page));
    await client(fetch).getPage('10', '实验说明');
    expect(fetch.mock.calls[0][1]).toBe(`${base}/pages/${encodeURIComponent('实验说明')}`);
    await client(fetch).getPage('10', 'page_id:40');
    expect(fetch.mock.calls[1][1]).toBe(`${base}/pages/page_id%3A40`);
    const invalid = vi.fn();
    for (const key of ['..', '../users', 'https://example.com', 'x?include=users', 'x#y', 'a\\b']) await expect(client(invalid).getPage('10', key)).rejects.toMatchObject({ code: 'BAD_ARGS' });
    await expect(client(invalid).listModules('../users')).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(invalid).not.toHaveBeenCalled();
  });
  it.each([[403, 'PERMISSION'], [404, 'NOT_FOUND']] as const)('HTTP %i 提供可操作提示，不把无权限当空列表', async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(json({}, {}, status));
    await expect(client(fetch).getPage('10', 'lab-guide')).rejects.toMatchObject({ code, hint: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('登录失败和页面格式变更如实报错', async () => {
    await expect(client(vi.fn().mockResolvedValue(json({}, {}, 401))).getPage('10', 'lab-guide')).rejects.toBeInstanceOf(NeedLoginError);
    await expect(client(vi.fn().mockResolvedValue(json({ ...page, page_id: null }))).getPage('10', 'lab-guide')).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
  });
});

describe('CLI 与 MCP 课程内容操作', () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { session: {} } as unknown as Ctx;
  const course = { id: '10', name: '虚构课程', courseCode: 'TEST001', teachers: [] };
  it('复用操作表，页面参数兼容 MCP；分歧或参数冲突时不读取内容', async () => {
    const courses = vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course, { ...course, id: '11' }]);
    const pages = vi.spyOn(CanvasClient.prototype, 'listPages').mockResolvedValue([]);
    const op = findOp('elearning.pages')!;
    expect(await runOp(op, ctx, { course: '10', page: 'lab-guide', search: '实验' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(courses).not.toHaveBeenCalled();
    expect(await runOp(op, ctx, { course: '虚构' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
    expect(pages).not.toHaveBeenCalled();
    expect(await runOp(op, ctx, { course: '10', search: '实验' })).toMatchObject({ ok: true, data: { courseId: '10', pages: [] } });
    expect(pages).toHaveBeenCalledWith('10', '实验');
    expect(z.object(mcpShape(op)).safeParse({ course: '10', page: 'lab-guide' }).success).toBe(true);
  });
  it('模块和单页命令返回课程信息及内容；都是只读操作', async () => {
    vi.spyOn(CanvasClient.prototype, 'listCourses').mockResolvedValue([course]);
    vi.spyOn(CanvasClient.prototype, 'listModules').mockResolvedValue([]);
    vi.spyOn(CanvasClient.prototype, 'getPage').mockResolvedValue({ id: '40' } as never);
    expect(await runOp(findOp('elearning.modules')!, ctx, { course: '10' })).toMatchObject({ ok: true, data: { courseId: '10', modules: [] } });
    expect(await runOp(findOp('elearning.pages')!, ctx, { course: '10', page: 'lab-guide' })).toMatchObject({ ok: true, data: { page: { id: '40' } } });
    expect(findOp('elearning.modules')!.effect).toBe('read');
    expect(findOp('elearning.pages')!.effect).toBe('read');
  });
});
