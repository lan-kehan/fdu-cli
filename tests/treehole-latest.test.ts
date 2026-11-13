import { describe, expect, it, vi } from 'vitest';
import { TreeholeClient, type HoleListOptions, type HoleTokens, type RawFetch } from '../src/services/treehole';
import { cacheTtl, runOp } from '../src/run';
import { findOp, type Ctx } from '../src/ops';
import { mcpShape } from '../src/mcp';
import { z } from 'zod';

const NOW = Date.parse('2026-11-13T08:00:00Z');
const hole = (id: number, created: string, updated = created) => ({ hole_id: id, division_id: 1, time_created: created, time_updated: updated, tags: [{ name: '虚构标签' }], floors: { first_floor: { content: '虚构帖子内容' } } });
const reply = (url: string, body: unknown, status = 200) => ({ status, url, contentType: 'application/json', text: JSON.stringify(body) });
function setup(body: unknown) {
  let tokens: HoleTokens | null = { access: 'fictional-access', refresh: 'fictional-refresh' };
  const fetch = vi.fn<RawFetch>(async (url) => reply(url, url.endsWith('/divisions') ? [{ division_id: 1, name: '虚构茶楼', description: '<p>讨论区</p>' }] : body));
  const client = new TreeholeClient({ fetch, ensureWebvpn: async () => {}, tokens: { get: () => tokens, set: (t) => { tokens = t; } }, now: () => NOW });
  return { client, fetch };
}

describe('树洞列表的排序、数量和时间游标', () => {
  it('默认明确发送发帖排序、当前时间游标和请求数量，不能依赖平台默认回复排序', async () => {
    const { client, fetch } = setup([hole(1, '2026-11-13T10:00:00+08:00')]);
    const rows = await client.latest({ length: 5, tag: '虚构标签', divisionId: 2 });
    expect(rows).toMatchObject([{ hole_id: 1, time: '2026-11-13 10:00', first_floor: '虚构帖子内容', createdAt: '2026-11-13T10:00:00+08:00', updatedAt: '2026-11-13T10:00:00+08:00' }]);
    const call = fetch.mock.calls.find(([url]) => url.includes('/holes?'))!;
    const query = new URL(call[0]);
    expect(Object.fromEntries(query.searchParams)).toEqual({ division_id: '2', length: '5', tag: '虚构标签', start_time: new Date(NOW).toISOString(), order: 'time_created' });
    expect(call[1]).toMatchObject({ headers: { Accept: 'application/json', Authorization: 'Bearer fictional-access' } });
    expect(fetch.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
  });
  it('服务端多返回时严格截断，先按指定时间排序并按洞号去重', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => hole(i + 1, `2026-11-13T${String(i).padStart(2, '0')}:00:00Z`));
    const { client } = setup([rows[0], rows[9], ...rows]);
    expect((await client.latest({ length: 5 })).map((h) => h.hole_id)).toEqual([10, 9, 8, 7, 6]);
    expect(await setup([]).client.latest()).toEqual([]);
  });
  it('支持最后回复顺序，保留原始发帖时间，并原样传递对应时间游标', async () => {
    const { client, fetch } = setup([
      hole(1, '2026-10-01T00:00:00Z', '2026-11-13T07:00:00Z'),
      hole(2, '2026-11-13T06:00:00Z', '2026-11-13T06:01:00Z'),
    ]);
    const before = '2026-11-13T16:00:00+08:00';
    const rows = await client.latest({ sort: 'updated', before });
    expect(rows.map((h) => h.hole_id)).toEqual([1, 2]);
    expect(rows[0].time).toBe('2026-10-01 00:00');
    const query = new URL(fetch.mock.calls.at(-1)![0]);
    expect(query.searchParams.get('order')).toBe('time_updated');
    expect(query.searchParams.get('start_time')).toBe(before);
  });
  it('按实际时刻比较不同时区，同一时刻按洞号从新到旧稳定排序；50 条不再被偷偷截成 20 条', async () => {
    const { client } = setup([hole(1, '2026-11-13T08:00:00+08:00'), hole(2, '2026-11-13T00:01:00Z'), hole(3, '2026-11-13T00:01:00Z')]);
    expect((await client.latest()).map((h) => h.hole_id)).toEqual([3, 2, 1]);
    const many = setup(Array.from({ length: 50 }, (_, i) => hole(i + 1, '2026-11-13T01:00:00Z')));
    expect(await many.client.latest({ length: 50 })).toHaveLength(50);
    expect(new URL(many.fetch.mock.calls.at(-1)![0]).searchParams.get('length')).toBe('50');
  });
  it.each([
    { length: 0 }, { length: 51 }, { length: 2.5 }, { divisionId: 0 },
    { sort: 'unknown' }, { before: '2026-11-13T12:00:00' }, { before: 'not-a-dateZ' },
  ])('无效参数在联网前报错：%j', async (opts) => {
    const { client, fetch } = setup([]);
    await expect(client.latest(opts as HoleListOptions)).rejects.toMatchObject({ code: 'BAD_ARGS', hint: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{}, null, [{ hole_id: 1 }], [hole(1, 'invalid')], [{ ...hole(1, '2026-11-13T01:00:00Z'), hole_id: 0 }]])('错误响应不伪装成空列表：%j', async (body) => {
    await expect(setup(body).client.latest()).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
  });
  it('分区列表提供名称、id 和简介，格式异常会报告错误', async () => {
    expect(await setup([]).client.divisions()).toEqual([{ division_id: 1, name: '虚构茶楼', description: '讨论区' }]);
    const client = new TreeholeClient({ fetch: async (url) => reply(url, { error: 'not an array' }), ensureWebvpn: async () => {}, tokens: { get: () => ({ access: 'a', refresh: 'r' }), set: () => {} } });
    await expect(client.divisions()).rejects.toMatchObject({ code: 'FORMAT_CHANGED' });
  });
  it('CLI/MCP 共用排序、分区和游标参数；实时列表缓存仅五分钟', async () => {
    const op = findOp('hole.latest')!;
    const shape = z.object(mcpShape(op));
    expect(shape.safeParse({ sort: 'updated', division: 2, length: 5, before: '2026-11-13T12:00:00+08:00' }).success).toBe(true);
    expect(shape.safeParse({ before: '2026-11-13' }).success).toBe(false);
    expect(cacheTtl(op)).toBe(5 * 60_000);
    expect(findOp('hole.divisions')!.effect).toBe('read');
    expect(await runOp(op, {} as Ctx, { length: '51' })).toMatchObject({ ok: false, error: { code: 'BAD_ARGS' } });
  });
});
