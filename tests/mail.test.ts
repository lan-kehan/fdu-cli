import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';
import { ImapMailClient } from '../src/services/mail';
import { findOp, type Ctx } from '../src/ops';

const config = { host: 'imap.example.test', port: 993, user: 'student@example.test', password: 'fake-password' };
const folders = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
  { path: '邮件/已发出', name: '已发出', specialUse: '\\Sent', flags: new Set<string>() },
  { path: 'Projects', name: 'Projects', flags: new Set(['\\Noselect']) },
];

function fixture() {
  const release = vi.fn();
  const raw = Buffer.from('From: Sender <sender@example.test>\r\nTo: recipient@example.test\r\nSubject: Example message\r\nDate: Fri, 13 Nov 2026 10:00:00 +0800\r\n\r\nExample body.');
  const connection = {
    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(folders),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    search: vi.fn().mockResolvedValue([7]),
    fetch: vi.fn().mockImplementation(async function* () { yield { uid: 7, source: raw }; }),
  };
  const client = new ImapMailClient(config, () => connection as unknown as ImapFlow);
  return { client, connection, release };
}

afterEach(() => vi.restoreAllMocks());

describe('只读邮箱文件夹', () => {
  it('列出路径、用途及可读取状态，不打开或修改文件夹', async () => {
    const { client, connection } = fixture();
    expect(await client.listFolders()).toEqual([
      { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', selectable: true },
      { path: '邮件/已发出', name: '已发出', specialUse: '\\Sent', selectable: true },
      { path: 'Projects', name: 'Projects', specialUse: undefined, selectable: false },
    ]);
    expect(connection.getMailboxLock).not.toHaveBeenCalled();
    expect(connection.logout).toHaveBeenCalledOnce();
  });

  it('默认仍以只读方式打开 INBOX，用 UID 读取且返回文件夹和收件人', async () => {
    const { client, connection, release } = fixture();
    expect(await client.fetchSince(new Date('2026-11-01'), 30)).toMatchObject([
      { uid: '7', folder: 'INBOX', to: ['recipient@example.test'], text: 'Example body.' },
    ]);
    expect(connection.list).not.toHaveBeenCalled();
    expect(connection.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(connection.fetch).toHaveBeenCalledWith([7], { uid: true, source: true }, { uid: true });
    expect(release).toHaveBeenCalledOnce();
    expect(connection.logout).toHaveBeenCalledOnce();
  });

  it('sent 按用途定位本地化名称，显式路径也能读取', async () => {
    const { client, connection } = fixture();
    for (const folder of ['sent', '邮件/已发出']) {
      expect(await client.fetchSince(new Date('2026-11-01'), 30, folder)).toMatchObject([{ folder: '邮件/已发出', uid: '7' }]);
    }
    expect(connection.getMailboxLock).toHaveBeenNthCalledWith(1, '邮件/已发出', { readOnly: true });
    expect(connection.getMailboxLock).toHaveBeenNthCalledWith(2, '邮件/已发出', { readOnly: true });
  });

  it('缺少用途标记时识别常见已发送名称', async () => {
    const { client, connection } = fixture();
    connection.list.mockResolvedValue([{ path: 'Sent Items', name: 'Sent Items', flags: new Set<string>() }]);
    await client.fetchSince(new Date(), 30, 'sent');
    expect(connection.getMailboxLock).toHaveBeenCalledWith('Sent Items', { readOnly: true });
  });

  it.each(['sent', 'Missing', 'Projects'])('找不到可读文件夹 %s 时不回退收件箱', async (folder) => {
    const { client, connection } = fixture();
    if (folder === 'sent') connection.list.mockResolvedValue([folders[0]]);
    await expect(client.fetchSince(new Date(), 30, folder)).rejects.toMatchObject({ code: 'NOT_FOUND', hint: expect.stringContaining('mail folders') });
    expect(connection.getMailboxLock).not.toHaveBeenCalled();
    expect(connection.logout).toHaveBeenCalledOnce();
  });

  it('读取失败释放锁、断开连接，且不暴露底层认证信息', async () => {
    const { client, connection, release } = fixture();
    connection.search.mockRejectedValue(new Error('private diagnostic'));
    await expect(client.fetchSince(new Date())).rejects.toMatchObject({ code: 'UPSTREAM', message: '连接或读取邮箱失败。' });
    expect(release).toHaveBeenCalledOnce();
    expect(connection.logout).toHaveBeenCalledOnce();
  });

  it('认证失败提供重新配置提示', async () => {
    const { client, connection } = fixture();
    connection.connect.mockRejectedValue({ authenticationFailed: true });
    await expect(client.listFolders()).rejects.toMatchObject({ code: 'NEED_MAIL_SETUP', hint: expect.stringContaining('客户端专用密码') });
    expect(connection.logout).toHaveBeenCalledOnce();
  });
});

describe('邮箱命令的文件夹参数', () => {
  it('列表按收件人过滤，并把相同 UID 限定在指定文件夹', async () => {
    const fetch = vi.spyOn(ImapMailClient.prototype, 'fetchSince').mockImplementation(async (_since, _limit, folder) => [{
      uid: '7', folder: folder ?? 'INBOX', from: { address: 'sender@example.test' }, to: ['recipient@example.test'],
      subject: 'Example', date: '2026-11-13T02:00:00Z', text: folder === 'sent' ? 'Sent body' : 'Inbox body',
    }]);
    const ctx = { now: () => Date.parse('2026-11-14T00:00:00Z'), store: { readJson: () => config } } as unknown as Ctx;
    const list = await findOp('mail.list')!.run(ctx, { folder: 'sent', query: 'recipient@example.test' });
    expect(list).toMatchObject([{ uid: '7', folder: 'sent', to: ['recipient@example.test'], snippet: 'Sent body' }]);
    expect(await findOp('mail.read')!.run(ctx, { uid: '7', folder: 'sent' })).toMatchObject({ folder: 'sent', text: 'Sent body' });
    expect(await findOp('mail.read')!.run(ctx, { uid: '7' })).toMatchObject({ folder: 'INBOX', text: 'Inbox body' });
    expect(fetch.mock.calls.map((call) => call[2])).toEqual(['sent', 'sent', undefined]);
  });
});
