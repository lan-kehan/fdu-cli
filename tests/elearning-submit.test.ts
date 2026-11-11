import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { CanvasSubmitClient } from '../src/services/elearning-submit';
import { NeedLoginError, type FudanAuth } from '../src/core/fudan-auth';
import { Session } from '../src/core/session';
import { sessionAuth } from '../src/core/auth';
import { Store } from '../src/core/store';
import { Cache } from '../src/core/cache';
import { findOp, readSubmissionFile, type Ctx, type Op } from '../src/ops';
import { cacheable, runOp } from '../src/run';

function storeAt(dir: string) {
  const previous = process.env.FDU_HOME;
  process.env.FDU_HOME = dir;
  try { return new Store(); } finally { if (previous === undefined) delete process.env.FDU_HOME; else process.env.FDU_HOME = previous; }
}
const base = 'https://elearning.fudan.edu.cn';
const path = `${base}/api/v1/courses/10/assignments/20`;
const assignment = { id: 20, course_id: 10, name: '虚构作业', html_url: `${base}/courses/10/assignments/20`, submission_types: ['online_upload', 'online_text_entry', 'online_url'], allowed_attempts: 3 };
const before = { id: 30, assignment_id: 20, attempt: 0, workflow_state: 'unsubmitted' };
const after = { ...before, attempt: 1, workflow_state: 'submitted', submitted_at: '2026-11-12T01:00:00Z', submission_type: 'online_text_entry', body: '<p>虚构答案</p>', attachments: [{ id: 40 }] };
const file = { name: '作业.pdf', data: new Uint8Array([1, 2, 3]) };
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
function setup(options: { assignment?: object; before?: object; post?: () => Promise<Response>; after?: () => Promise<Response>; redirect?: string } = {}) {
  let submittedType = 'online_text_entry';
  const fetch = vi.fn(async (_platform: string, url: string, init?: RequestInit): Promise<Response> => {
    if (url === path) return json({ ...assignment, ...options.assignment });
    if (url === `${path}/submissions/self`) return fetch.mock.calls.filter(([, u]) => u === url).length === 1 ? json({ ...before, ...options.before }) : options.after ? options.after() : json({ ...after, submission_type: submittedType });
    if (url.endsWith('/submissions/self/files')) return json({ upload_url: 'https://uploads.example.com/upload', upload_params: { key: 'opaque-key', signature: 'fictional-signature' } });
    if (url === 'https://uploads.example.com/upload') return options.redirect ? new Response(null, { status: 303, headers: { Location: options.redirect } }) : json({ id: 40 }, 201);
    if (url.startsWith(`${base}/api/v1/files/40`)) return json({ id: 40 });
    if (url === `${path}/submissions` && init?.method === 'POST') {
      submittedType = JSON.parse(String(init.body)).submission.submission_type;
      return options.post ? options.post() : json({ ...after, submission_type: submittedType }, 201);
    }
    throw new Error(`Unexpected mock URL: ${url}`);
  });
  const csrfToken = vi.fn(async () => 'fictional-csrf');
  const client = new CanvasSubmitClient({ fetch, csrfToken } as unknown as FudanAuth);
  return { client, fetch, csrfToken };
}

describe('eLearning 作业提交协议（仅虚构数据）', () => {
  it('预览只读，不申请上传、不提交、不取 CSRF；显示已有提交和迟交', async () => {
    const { client, fetch, csrfToken } = setup({ before: { ...after }, assignment: { due_at: '2026-01-01T00:00:00Z' } });
    expect(await client.submit('10', '20', { file, dryRun: true })).toMatchObject({ dryRun: true, alreadySubmitted: true, late: true, file: { name: file.name, bytes: 3 } });
    expect(fetch.mock.calls.every(([, , init]) => !init?.method)).toBe(true);
    expect(csrfToken).not.toHaveBeenCalled();
  });
  it('Cookie 写请求附带 CSRF，不使用 Bearer；发送一次后查询核验', async () => {
    const { client, fetch } = setup();
    expect(await client.submit('10', '20', { text: '<p>虚构答案</p>' })).toMatchObject({ verified: true, submission: { attempt: 1, id: '30' } });
    const calls = fetch.mock.calls.filter(([, , init]) => init?.method === 'POST');
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toMatchObject({ redirect: 'manual', headers: { 'X-CSRF-Token': 'fictional-csrf' }, body: JSON.stringify({ submission: { submission_type: 'online_text_entry', body: '<p>虚构答案</p>' } }) });
    expect(new Headers(calls[0][2]?.headers).has('Authorization')).toBe(false);
  });
  it('完整上传、确认重定向、再提交：保留签名字段，文件最后，不向跨域存储发送 CSRF', async () => {
    const { client, fetch } = setup({ redirect: `${base}/api/v1/files/40/create_success?uuid=fictional` });
    expect(await client.submit('10', '20', { file })).toMatchObject({ verified: true, submission: { fileId: '40' } });
    const upload = fetch.mock.calls.find(([, url]) => url === 'https://uploads.example.com/upload')![2]!;
    expect([...((upload.body as FormData).keys())]).toEqual(['key', 'signature', 'file']);
    expect((upload.body as FormData).get('signature')).toBe('fictional-signature');
    expect(new Headers(upload.headers).has('X-CSRF-Token')).toBe(false);
    const ticket = fetch.mock.calls.find(([, url]) => url.endsWith('/submissions/self/files'))![2]!;
    expect(JSON.parse(String(ticket.body))).toMatchObject({ on_duplicate: 'rename', name: '作业.pdf', size: 3 });
    expect(JSON.parse(String(fetch.mock.calls.find(([, url]) => url === `${path}/submissions`)![2]!.body))).toMatchObject({ submission: { file_ids: ['40'] } });
  });
  it('上传返回 JSON 文件 id 也能完成；提交网址使用 online_url', async () => {
    const { client } = setup();
    expect(await client.submit('10', '20', { file })).toMatchObject({ verified: true });
    const url = setup({ after: async () => json({ ...after, url: 'https://example.com/report', submission_type: 'online_url' }) });
    expect(await url.client.submit('10', '20', { url: 'https://example.com/report' })).toMatchObject({ submissionType: 'online_url', verified: true });
  });
  it.each([
    { assignment: { locked_for_user: true } },
    { assignment: { unlock_at: '2099-01-01T00:00:00Z' } },
    { assignment: { lock_at: '2000-01-01T00:00:00Z' } },
    { assignment: { submission_types: ['external_tool'] } },
    { assignment: { allowed_extensions: ['zip'] } },
    { assignment: { allowed_attempts: 1 }, before: { attempt: 1 } },
    { before: { excused: true } },
    { before: after },
  ])('预检不通过时不会上传或提交：%j', async (options) => {
    const { client, fetch } = setup(options);
    await expect(client.submit('10', '20', { file })).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(fetch.mock.calls.every(([, , init]) => !init?.method)).toBe(true);
  });
  it('显式允许重交，检查新的 attempt，不把旧记录当成功', async () => {
    const { client } = setup({ before: after, post: async () => json({ ...after, attempt: 2, submission_type: 'online_upload' }), after: async () => json({ ...after, attempt: 2, submission_type: 'online_upload' }) });
    expect(await client.submit('10', '20', { file, resubmit: true })).toMatchObject({ submission: { attempt: 2 }, verified: true });
    const old = setup({ before: after });
    await expect(old.client.submit('10', '20', { file, resubmit: true })).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN' });
  });
  it('POST 超时但服务端已接受：只查询，内容和 attempt 匹配时返回成功', async () => {
    const { client, fetch } = setup({ post: async () => { throw new Error('timeout'); } });
    expect(await client.submit('10', '20', { file })).toMatchObject({ verified: true });
    expect(fetch.mock.calls.filter(([, url]) => url === `${path}/submissions`)).toHaveLength(1);
  });
  it.each([
    async () => json(before),
    async () => json({ ...after, body: '别的答案', attachments: [{ id: 999 }] }),
    async () => { throw new Error('timeout'); },
  ])('POST 超时且无法确认时返回 SUBMISSION_UNKNOWN，不重发', async (readAfter) => {
    const { client, fetch } = setup({ post: async () => { throw new Error('timeout'); }, after: readAfter });
    await expect(client.submit('10', '20', { file })).rejects.toMatchObject({ code: 'SUBMISSION_UNKNOWN', hint: expect.stringContaining('/courses/10/assignments/20') });
    expect(fetch.mock.calls.filter(([, url]) => url === `${path}/submissions`)).toHaveLength(1);
  });
  it('服务端拒绝提交参数或权限时保留可操作的错误，不重试', async () => {
    for (const [status, code] of [[422, 'BAD_ARGS'], [403, 'PERMISSION']] as const) {
      const { client, fetch } = setup({ post: async () => json({}, status) });
      await expect(client.submit('10', '20', { text: '虚构' })).rejects.toMatchObject({ code });
      expect(fetch.mock.calls.filter(([, url]) => url === `${path}/submissions`)).toHaveLength(1);
    }
  });
  it('拒绝跨站上传确认重定向，不发作业提交请求', async () => {
    const { client, fetch } = setup({ redirect: 'https://other.example.com/api/v1/files/40' });
    await expect(client.submit('10', '20', { file })).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
    expect(fetch.mock.calls.some(([, url]) => url === `${path}/submissions`)).toBe(false);
  });
  it('拒绝无效内容与路径注入，在请求之前失败', async () => {
    const { client, fetch } = setup();
    for (const input of [{}, { file, text: '答案' }, { text: ' ' }, { url: 'file:///tmp/a' }, { file: { ...file, data: new Uint8Array() } }]) {
      await expect(client.submit('10', '20', input)).rejects.toMatchObject({ code: 'BAD_ARGS' });
    }
    await expect(client.submit('../10', '20', { file })).rejects.toMatchObject({ code: 'BAD_ARGS' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('会话适配、命令和文件边界', () => {
  it('认证适配器把 FormData 转为 Playwright multipart，保留二进制与手动跳转', async () => {
    const fetch = vi.fn(async () => ({ status: 201, url: `${base}/upload`, body: Buffer.from('{"id":40}'), headers: { 'content-type': 'application/json' } }));
    const auth = sessionAuth({ fetch } as unknown as Session);
    const form = new FormData();
    form.append('key', 'fictional');
    form.append('file', new Blob([file.data]), file.name);
    await auth.fetch('elearning', `${base}/upload`, { method: 'POST', redirect: 'manual', body: form });
    expect(fetch).toHaveBeenCalledWith('elearning', `${base}/upload`, expect.objectContaining({ maxRedirects: 0, multipart: { key: 'fictional', file: { name: file.name, mimeType: 'application/octet-stream', buffer: Buffer.from(file.data) } } }));
  });
  it('从目标域读取并解码有效 CSRF Cookie，忽略其他站点和过期 Cookie', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdu-csrf-test-'));
    const store = storeAt(dir);
    const cookie = { name: '_csrf_token', value: 'fictional%2Bvalue%3D', domain: 'elearning.fudan.edu.cn', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' };
    store.writeJson('state.json', { origins: [], cookies: [{ ...cookie, domain: 'example.com', value: 'wrong' }, { ...cookie, expires: 1, value: 'expired' }, cookie] });
    const session = new Session(store);
    expect(await session.csrfToken('elearning')).toBe('fictional+value=');
    await session.close();
  });
  it('MCP 文件检查包含符号链接；CLI 可以读取工作目录外的指定文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdu-upload-test-'));
    mkdirSync(join(dir, 'work'));
    writeFileSync(join(dir, 'outside.pdf'), 'fictional');
    writeFileSync(join(dir, 'work', 'answer.pdf'), 'fictional');
    symlinkSync(join(dir, 'outside.pdf'), join(dir, 'work', 'link.pdf'));
    const ctx = { cwd: join(dir, 'work'), mcp: true };
    expect(readSubmissionFile(ctx, 'answer.pdf').name).toBe('answer.pdf');
    for (const name of ['../outside.pdf', 'link.pdf', '.', 'missing.pdf']) expect(() => readSubmissionFile(ctx, name)).toThrow();
    expect(readSubmissionFile({ ...ctx, mcp: false }, '../outside.pdf').name).toBe('outside.pdf');
  });
  it('远端写不缓存、不自动登录后重跑；缓存清理保留其他查询', async () => {
    const op = findOp('elearning.submit')!;
    expect(cacheable(op)).toBe(false);
    const relogin = vi.fn(async () => true);
    const run = vi.fn(async () => { throw new NeedLoginError('elearning'); });
    expect(await runOp({ ...op, params: {}, run } as Op, { relogin } as unknown as Ctx, {})).toMatchObject({ ok: false, error: { code: 'NEED_LOGIN' } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(relogin).not.toHaveBeenCalled();
    const cache = new Cache(storeAt(mkdtempSync(join(tmpdir(), 'fdu-submit-cache-'))));
    cache.set('elearning.assignments', {}, []);
    cache.set('jw.grades', {}, []);
    expect(cache.clear(['elearning.assignments'])).toBe(1);
    expect(cache.get('elearning.assignments', {})).toBeNull();
    expect(cache.get('jw.grades', {})).not.toBeNull();
  });
});


describe('真实 HTTP 传输到本机虚构 Canvas', () => {
  it('完整经过 Cookie 会话、CSRF、multipart、上传确认和提交核验；无真实学校请求', async () => {
    const requests: { url: string; method: string; csrf?: string; cookie?: string; body: Buffer }[] = [];
    let submitted = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({ url: req.url!, method: req.method!, csrf: req.headers['x-csrf-token'] as string, cookie: req.headers.cookie, body });
      const reply = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/api/v1/courses/10/assignments/20') return reply(assignment);
      if (req.url === '/api/v1/courses/10/assignments/20/submissions/self') return reply(submitted ? { ...after, submission_type: 'online_upload' } : before);
      if (req.url?.endsWith('/submissions/self/files')) return reply({ upload_url: `${base}/upload`, upload_params: { signature: 'fictional', success_action_status: 201 } });
      if (req.url === '/upload') { res.writeHead(303, { Location: `${base}/api/v1/files/40/create_success` }); res.end(); return; }
      if (req.url === '/api/v1/files/40/create_success') return reply({ id: 40 });
      if (req.url?.endsWith('/submissions')) { submitted = true; return reply({ ...after, submission_type: 'online_upload' }, 201); }
      reply({}, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const local = `http://127.0.0.1:${address.port}`;
    const store = storeAt(mkdtempSync(join(tmpdir(), 'fdu-http-submit-')));
    store.writeJson('state.json', { origins: [], cookies: [
      { name: '_csrf_token', value: 'fictional%2Bcsrf', domain: 'elearning.fudan.edu.cn', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
      { name: 'fictional_session', value: 'local-session', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
    ] });
    const session = new Session(store);
    const adapter = sessionAuth(session);
    // 只替换传输目的地，服务层仍使用正式协议中的 URL；不访问学校系统。
    const auth: FudanAuth = { ...adapter, fetch: (platform, url, init) => {
      const u = new URL(url);
      return adapter.fetch(platform, `${local}${u.pathname}${u.search}`, init);
    } };
    const savedProxy = new Map(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => [k, process.env[k]]));
    for (const k of savedProxy.keys()) delete process.env[k];
    try {
      expect(await new CanvasSubmitClient(auth).submit('10', '20', { file })).toMatchObject({ verified: true, submission: { fileId: '40' } });
      const writes = requests.filter((r) => r.method === 'POST');
      expect(writes).toHaveLength(3);
      expect(writes.every((r) => r.csrf === 'fictional+csrf' && r.cookie?.includes('fictional_session=local-session'))).toBe(true);
      const upload = writes.find((r) => r.url === '/upload')!.body;
      expect(upload.includes(Buffer.from([1, 2, 3]))).toBe(true);
      expect(upload.toString().indexOf('name="signature"')).toBeLessThan(upload.toString().indexOf('name="file"'));
      expect(requests.find((r) => r.url === '/api/v1/files/40/create_success')?.method).toBe('GET');
      expect(JSON.parse(writes[2].body.toString())).toMatchObject({ submission: { file_ids: ['40'] } });
    } finally {
      await session.close();
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
      for (const [k, value] of savedProxy) { if (value === undefined) delete process.env[k]; else process.env[k] = value; }
    }
  });
});
