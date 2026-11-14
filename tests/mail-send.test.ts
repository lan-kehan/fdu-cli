import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapMailClient } from '../src/services/mail';
import { MAX_MAIL_RECIPIENTS, SmtpMailSender, parseAddresses, type OutgoingMail, type SmtpTransport } from '../src/services/mail-send';
import { findOp, type Ctx } from '../src/ops';
import { runOp } from '../src/run';
import { toolDescription } from '../src/mcp';

// 全部是虚构的地址和内容，不连接任何真实服务器
const config = { host: 'smtp.example.test', port: 465, user: 'student@example.test', password: 'fake-password' };
const base: OutgoingMail = { to: ['teacher@example.test'], cc: [], bcc: [], subject: '虚构主题', text: '老师好，这是虚构正文。' };

function transport(result: object | Error = { messageId: '<m1@example.test>', accepted: ['teacher@example.test'], rejected: [], response: '250 OK' }) {
  const t = {
    sendMail: vi.fn(async (_message: Record<string, unknown>) => { if (result instanceof Error) throw result; return result; }),
    close: vi.fn(),
  };
  return { t, sender: new SmtpMailSender(config, () => t as unknown as SmtpTransport) };
}
const smtpError = (code: string, command?: string, responseCode?: number) => Object.assign(new Error('private diagnostic fake-password'), { code, command, responseCode });

afterEach(() => vi.restoreAllMocks());

describe('收件人地址', () => {
  it('逗号、分号（含全角）和空白都能分隔', () => {
    expect(parseAddresses('a@example.test, b@example.test；c@example.test  d@example.test', '--to')).toEqual(['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test']);
    expect(parseAddresses(undefined, '--cc')).toEqual([]);
  });
  it.each(['Teacher <t@example.test>', 'no-at-sign', 'a@b', 'x@example.test\r\nBcc: y@example.test'])('拒绝不是纯地址的 %j', (value) => {
    expect(() => parseAddresses(value, '--to')).toThrow(expect.objectContaining({ code: 'BAD_ARGS' }));
  });
});

describe('SMTP 发信（仅虚构数据）', () => {
  it('dry-run 只返回预览，不连接服务器', async () => {
    const create = vi.fn();
    const sender = new SmtpMailSender(config, create);
    expect(await sender.send({ ...base, fromName: '张三', attachment: { name: '作业.pdf', data: new Uint8Array([1, 2, 3]) } }, { dryRun: true })).toMatchObject({
      dryRun: true, sent: false, from: '张三 <student@example.test>', to: ['teacher@example.test'], attachment: { name: '作业.pdf', bytes: 3 }, server: 'smtp.example.test:465',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('发送一次、断开连接，服务器接收全部收件人时 verified 为真', async () => {
    const { t, sender } = transport({ messageId: '<m1@example.test>', accepted: ['teacher@example.test', { address: 'ta@example.test' }], rejected: [], response: '250 OK' });
    const result = await sender.send({ ...base, cc: ['TA@example.test'], attachment: { name: 'a.txt', data: new Uint8Array([65]) } });
    expect(result).toMatchObject({ sent: true, verified: true, messageId: '<m1@example.test>', accepted: ['teacher@example.test', 'ta@example.test'] });
    expect(t.sendMail).toHaveBeenCalledOnce();
    expect(t.sendMail.mock.calls[0][0]).toMatchObject({ from: 'student@example.test', to: ['teacher@example.test'], cc: ['TA@example.test'], subject: '虚构主题', attachments: [{ filename: 'a.txt' }] });
    expect(t.sendMail.mock.calls[0][0]).not.toHaveProperty('bcc');
    expect(t.close).toHaveBeenCalledOnce();
  });

  it('部分收件人被拒时如实报告，verified 为假', async () => {
    const { sender } = transport({ accepted: ['teacher@example.test'], rejected: ['ghost@example.test'] });
    expect(await sender.send({ ...base, to: ['teacher@example.test', 'ghost@example.test'] })).toMatchObject({ sent: true, verified: false, rejected: ['ghost@example.test'] });
  });

  it('回复时带上 In-Reply-To 和 References', async () => {
    const { t, sender } = transport();
    await sender.send({ ...base, inReplyTo: '<orig@example.test>', references: ['<root@example.test>', '<orig@example.test>'] });
    expect(t.sendMail.mock.calls[0][0]).toMatchObject({ inReplyTo: '<orig@example.test>', references: ['<root@example.test>', '<orig@example.test>'] });
  });

  it.each([
    [{ to: [] }, '收件人'],
    [{ cc: ['teacher@example.test'] }, '不止一次'],
    [{ to: Array.from({ length: MAX_MAIL_RECIPIENTS + 1 }, (_, i) => `s${i}@example.test`) }, '不能超过'],
    [{ subject: '  ' }, '主题'],
    [{ subject: '第一行\r\nBcc: x@example.test' }, '换行'],
    [{ fromName: 'A <evil@example.test>' }, '显示名'],
    [{ text: ' \n ' }, '正文'],
    [{ attachment: { name: 'big.bin', data: new Uint8Array(20 * 1024 * 1024 + 1) } }, '附件'],
  ])('发送前拒绝 %#，不连接服务器', async (patch, words) => {
    const create = vi.fn();
    await expect(new SmtpMailSender(config, create).send({ ...base, ...patch } as OutgoingMail)).rejects.toMatchObject({ code: 'BAD_ARGS', message: expect.stringContaining(words) });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [smtpError('EAUTH', 'AUTH PLAIN', 535), 'NEED_MAIL_SETUP'],
    [smtpError('EENVELOPE', 'RCPT TO', 550), 'BAD_ARGS'],
    [smtpError('ECONNECTION', 'CONN'), 'UPSTREAM'],
    [smtpError('ETIMEDOUT', 'CONN'), 'UPSTREAM'],
    [smtpError('ETIMEDOUT', 'DATA'), 'MAIL_UNKNOWN'],
    [smtpError('ESOCKET'), 'MAIL_UNKNOWN'],
  ])('错误 %#：分清没发出和结果不明，不重试、不泄露密码', async (error, code) => {
    const { t, sender } = transport(error);
    const rejected = await sender.send(base).catch((e) => e);
    expect(rejected).toMatchObject({ code });
    expect(rejected.message).not.toContain('fake-password');
    expect(t.sendMail).toHaveBeenCalledOnce();
    expect(t.close).toHaveBeenCalledOnce();
  });
});

describe('mail send 命令', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const stored = { host: 'imap.example.test', port: 993, user: 'student@example.test', password: 'fake-password' };
  function ctx(extra: Partial<Ctx> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'fdu-mail-'));
    dirs.push(dir);
    const clear = vi.fn();
    return { dir, clear, ctx: { cwd: dir, now: () => Date.parse('2026-11-14T00:00:00Z'), log: () => undefined, store: { readJson: () => stored }, cache: { clear }, ...extra } as unknown as Ctx };
  }
  const op = findOp('mail.send')!;

  it('是需要邮箱、标明对外发送的远端写入操作，MCP 描述提醒先预览', () => {
    expect(op).toMatchObject({ login: 'mail', effect: 'remote-write', sensitive: true, cache: false });
    expect(toolDescription(op)).toContain('dryRun');
    expect(toolDescription(op)).toContain('不能自动重发');
    expect(toolDescription(findOp('elearning.submit')!)).toContain('占用提交次数');
  });

  it('dry-run 读取正文文件，使用默认 SMTP 服务器，不清缓存', async () => {
    const send = vi.spyOn(SmtpMailSender.prototype, 'send');
    const { dir, ctx: c, clear } = ctx();
    writeFileSync(join(dir, 'body.txt'), '﻿老师好：\n虚构正文。');
    const result = await op.run(c, { to: 'teacher@example.test', subject: '虚构', textFile: 'body.txt', dryRun: true });
    expect(result).toMatchObject({ dryRun: true, sent: false, text: '老师好：\n虚构正文。', server: 'smtp.exmail.qq.com:465', replyTo: null });
    expect(send).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
  });

  it('真实发送后清除邮件列表缓存', async () => {
    vi.spyOn(SmtpMailSender.prototype, 'send').mockResolvedValue({ sent: true } as never);
    const { ctx: c, clear } = ctx();
    await op.run(c, { to: 'teacher@example.test', subject: '虚构', text: '正文' });
    expect(clear).toHaveBeenCalledWith(['mail.list']);
  });

  it('按 uid 回复：默认回给原发件人，主题加 Re:，带原 Message-ID', async () => {
    vi.spyOn(ImapMailClient.prototype, 'fetchSince').mockResolvedValue([{
      uid: '9', folder: 'INBOX', messageId: '<orig@example.test>', threadKey: '<root@example.test>', from: { address: 'teacher@example.test' }, to: ['student@example.test'],
      subject: '关于作业', date: '2026-11-13T02:00:00Z', text: '虚构原文',
    }]);
    const { ctx: c } = ctx();
    expect(await op.run(c, { replyUid: '9', text: '收到，谢谢老师！', dryRun: true })).toMatchObject({
      to: ['teacher@example.test'], subject: 'Re: 关于作业', inReplyTo: '<orig@example.test>', replyTo: { uid: '9', from: 'teacher@example.test' },
    });
  });

  it('找不到要回复的邮件时不发送', async () => {
    vi.spyOn(ImapMailClient.prototype, 'fetchSince').mockResolvedValue([]);
    const send = vi.spyOn(SmtpMailSender.prototype, 'send');
    const { ctx: c } = ctx();
    await expect(op.run(c, { replyUid: '404', text: '正文' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [{ to: 'teacher@example.test', subject: 's' }, '缺少正文'],
    [{ to: 'teacher@example.test', subject: 's', text: 'a', textFile: 'b.txt' }, '只能选一个'],
  ])('参数错误 %#', async (args, words) => {
    const { ctx: c } = ctx();
    await expect(op.run(c, args)).rejects.toMatchObject({ code: 'BAD_ARGS', message: expect.stringContaining(words) });
  });

  it('MCP 只允许读取工作目录内的附件和正文文件，正文须是 UTF-8', async () => {
    const { dir, ctx: c } = ctx({ mcp: true });
    mkdirSync(join(dir, 'work'));
    writeFileSync(join(dir, 'outside.txt'), '目录外');
    writeFileSync(join(dir, 'work', 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    symlinkSync(join(dir, 'outside.txt'), join(dir, 'work', 'link.txt'));
    const inner = { ...c, cwd: join(dir, 'work') } as Ctx;
    const args = { to: 'teacher@example.test', subject: 's', dryRun: true };
    await expect(op.run(inner, { ...args, text: 'a', file: '../outside.txt' })).rejects.toMatchObject({ code: 'BAD_ARGS', message: expect.stringContaining('MCP') });
    await expect(op.run(inner, { ...args, textFile: 'link.txt' })).rejects.toMatchObject({ code: 'BAD_ARGS', message: expect.stringContaining('MCP') });
    await expect(op.run(inner, { ...args, textFile: 'gbk.txt' })).rejects.toMatchObject({ code: 'BAD_ARGS', message: expect.stringContaining('UTF-8') });
  });

  it('没有配置邮箱时提示 mail setup', async () => {
    const { ctx: c } = ctx({ store: { readJson: () => undefined } } as unknown as Partial<Ctx>);
    const result = await runOp(op, c, { to: 'teacher@example.test', subject: 's', text: 'a', dryRun: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'NEED_MAIL_SETUP' } });
  });
});
