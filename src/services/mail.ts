import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { FduError } from '../core/errors';

export interface MailMessage {
  /** 文件夹内唯一 ID；读取时须使用同一文件夹 */
  uid: string;
  folder: string;
  messageId?: string;
  threadKey?: string;
  from: { name?: string; address: string };
  to: string[];
  subject: string;
  date: string;
  text: string;
}

export interface MailClient {
  fetchSince(since: Date, limit?: number, folder?: string): Promise<MailMessage[]>;
  ping(): Promise<boolean>;
  /**
   * 盯着收件箱：有新邮件时回调（IMAP IDLE，服务器主动通知）。返回停止函数。
   * onState 报告连接状态，断开后会自动重连。
   */
  watch?(onNew: () => void, onState?: (state: 'watching' | 'reconnecting' | 'stopped', error?: string) => void): () => Promise<void>;
}

export interface ImapConfig {
  /** 学生邮箱 @m.fudan.edu.cn 复旦官方客户端指南使用腾讯企业邮服务器，账号授权需实测 */
  host: string;
  port: number;
  user: string;
  /** 客户端专用密码（不是 UIS 密码） */
  password: string;
}

export const DEFAULT_FUDAN_STUDENT_IMAP = { host: 'imap.exmail.qq.com', port: 993 };

export interface MailFolder {
  path: string;
  name: string;
  specialUse?: string;
  selectable: boolean;
}

function mailError(error: unknown): FduError {
  if (error instanceof FduError) return error;
  const e = error as { code?: string; authenticationFailed?: boolean };
  if (e.authenticationFailed || e.code === 'AUTHENTICATIONFAILED') {
    return new FduError('NEED_MAIL_SETUP', '邮箱认证失败。', '检查邮箱地址、客户端专用密码，并确认网页邮箱已开启 IMAP。');
  }
  return new FduError('UPSTREAM', '连接或读取邮箱失败。', '检查邮箱服务器、端口和网络连接后重试。');
}

/** IMAP 只读客户端：不标记已读、不删除、不移动。 */
export class ImapMailClient implements MailClient {
  constructor(private readonly config: ImapConfig, private readonly createClient?: () => ImapFlow) {}

  private connect(): ImapFlow {
    if (this.createClient) return this.createClient();
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: true,
      auth: { user: this.config.user, pass: this.config.password },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
  }

  /**
   * 保持一个只读连接打开收件箱并进入 IDLE：新邮件到达时服务器会马上通知（exists 事件）。
   * 断线后指数退避重连（5 秒起，最长 5 分钟）。不标记已读，不改动任何邮件。
   */
  watch(onNew: () => void, onState?: (state: 'watching' | 'reconnecting' | 'stopped', error?: string) => void): () => Promise<void> {
    let stopped = false;
    let client: ImapFlow | undefined;
    let delay = 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = (error?: string) => {
      if (stopped || timer) return;
      onState?.('reconnecting', error);
      timer = setTimeout(() => { timer = undefined; void run(); }, delay);
      delay = Math.min(delay * 2, 5 * 60_000);
    };
    const run = async () => {
      if (stopped) return;
      client = new ImapFlow({
        host: this.config.host, port: this.config.port, secure: true,
        auth: { user: this.config.user, pass: this.config.password }, logger: false,
        connectionTimeout: 20_000, greetingTimeout: 20_000,
        // IDLE 连接会长时间没有数据：每 4 分钟重新发一次 IDLE，保持连接
        socketTimeout: 10 * 60_000, maxIdleTime: 4 * 60_000,
      });
      const c = client;
      let count = -1;
      c.on('exists', (data: { count: number; prevCount: number }) => {
        if (data.count > (count >= 0 ? count : data.prevCount)) onNew();
        count = data.count;
      });
      c.on('close', () => reconnect());
      c.on('error', () => { /* 交给 close 处理重连 */ });
      try {
        await c.connect();
        const box = await c.mailboxOpen('INBOX', { readOnly: true });
        count = box.exists;
        delay = 5_000;
        onState?.('watching');
        // 连接期间补一次：断线时可能错过了新邮件
        onNew();
      } catch (e) {
        await c.logout().catch(() => c.close());
        reconnect((e as Error).message);
      }
    };
    void run();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      onState?.('stopped');
      await client?.logout().catch(() => client?.close());
    };
  }

  async ping(): Promise<boolean> {
    const client = this.connect();
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async folders(client: ImapFlow): Promise<MailFolder[]> {
    return (await client.list()).map((box) => ({
      path: box.path, name: box.name, specialUse: box.specialUse,
      selectable: !box.flags.has('\\Noselect'),
    }));
  }

  async listFolders(): Promise<MailFolder[]> {
    const client = this.connect();
    try {
      await client.connect();
      return await this.folders(client);
    } catch (error) {
      throw mailError(error);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async resolveFolder(client: ImapFlow, requested: string): Promise<string> {
    if (requested.toUpperCase() === 'INBOX') return 'INBOX';
    const folders = await this.folders(client);
    const folder = requested.toLowerCase() === 'sent'
      ? folders.find((box) => box.selectable && box.specialUse === '\\Sent')
        ?? folders.find((box) => box.selectable && /^(sent|sent items|sent messages|已发送|已发送邮件)$/i.test(box.name))
      : folders.find((box) => box.path === requested);
    if (!folder?.selectable) throw new FduError('NOT_FOUND', '没有找到可读取的邮箱文件夹。', '运行 `fdu mail folders`，将返回的 path 原样传给 --folder。');
    return folder.path;
  }

  async fetchSince(since: Date, limit?: number, folder = 'INBOX'): Promise<MailMessage[]> {
    const client = this.connect();
    const out: MailMessage[] = [];
    try {
      await client.connect();
      const path = await this.resolveFolder(client, folder);
      // readOnly：以 EXAMINE 打开，保证不改变邮件状态
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        // 同步默认读取全部命中邮件，避免截断后推进游标造成永久漏信。
        const recent = limit === undefined ? uids : uids.slice(-Math.max(0, Math.floor(limit)));
        if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) return out;
        if (recent.length === 0) return out;
        for (let offset = 0; offset < recent.length; offset += 100) {
          for await (const msg of client.fetch(recent.slice(offset, offset + 100), { uid: true, source: true }, { uid: true })) {
            if (!msg.source) continue;
            const parsed = await simpleParser(msg.source);
            const from = parsed.from?.value?.[0];
            const toList = Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [];
            out.push({
              uid: String(msg.uid),
              folder: path,
              messageId: parsed.messageId,
              threadKey: (parsed.references && [parsed.references].flat()[0]) || parsed.messageId,
              from: { name: from?.name, address: from?.address ?? '' },
              to: toList.flatMap((t) => t.value.map((v) => v.address ?? '')),
              subject: parsed.subject ?? '(无主题)',
              date: (parsed.date ?? new Date()).toISOString(),
              text: (parsed.text ?? '').slice(0, 8000),
            });
          }
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      throw mailError(error);
    } finally {
      await client.logout().catch(() => undefined);
    }
    return out;
  }
}
