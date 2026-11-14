import { createTransport } from 'nodemailer';
import { FduError } from '../core/errors';

/** 复旦学生邮箱（腾讯企业邮）的发信服务器；与 IMAP 共用客户端专用密码 */
export const DEFAULT_FUDAN_STUDENT_SMTP = { host: 'smtp.exmail.qq.com', port: 465 };
/** 单个附件上限：企业邮普通附件约 50 MB，编码后体积会变大，这里留足余量 */
export const MAX_MAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** 一封邮件的收件人、抄送、密送合计上限：fdu 只用来写个人邮件，不做群发 */
export const MAX_MAIL_RECIPIENTS = 30;
export const MAX_MAIL_TEXT_CHARS = 100_000;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  /** 客户端专用密码（不是 UIS 密码） */
  password: string;
}

export interface OutgoingMail {
  fromName?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachment?: { name: string; data: Uint8Array };
  /** 回复时原邮件的 Message-ID */
  inReplyTo?: string;
  references?: string[];
}

export interface SmtpSendInfo {
  messageId?: string;
  accepted?: unknown[];
  rejected?: unknown[];
  response?: string;
}

export interface SmtpTransport {
  sendMail(message: Record<string, unknown>): Promise<SmtpSendInfo>;
  close?(): void;
}

const ADDRESS = /^[^\s@<>(),;:"[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** 「a@x.com, b@y.com；c@z.com」→ 地址数组；逗号、分号（含全角）和空白都可以分隔。 */
export function parseAddresses(value: string | undefined, flag: string): string[] {
  if (value === undefined) return [];
  const list = value.split(/[,;，；\s]+/).map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((a) => !ADDRESS.test(a));
  if (bad.length) throw new FduError('BAD_ARGS', `${flag} 里有无效的邮箱地址：${bad.slice(0, 3).join('、')}。`, '只写纯地址（如 someone@fudan.edu.cn），多个地址用逗号分隔，不要写显示名。');
  return list;
}

const address = (a: unknown) => typeof a === 'string' ? a : (a as { address?: string })?.address ?? String(a);

/** 发信前的检查：收件人、主题和正文，都在连接服务器之前完成 */
export function checkOutgoing(mail: OutgoingMail): void {
  const all = [...mail.to, ...mail.cc, ...mail.bcc].map((a) => a.toLowerCase());
  if (!mail.to.length) throw new FduError('BAD_ARGS', '至少要有一个收件人。', '用 --to 指定收件人；回复邮件时可以用 --reply-uid 自动填写。');
  if (new Set(all).size !== all.length) throw new FduError('BAD_ARGS', '同一个地址在收件人、抄送、密送里出现了不止一次。', '去掉重复的地址。');
  if (all.length > MAX_MAIL_RECIPIENTS) throw new FduError('BAD_ARGS', `收件人、抄送、密送合计不能超过 ${MAX_MAIL_RECIPIENTS} 个。`, 'fdu 只用来发个人邮件，不做群发。');
  if (!mail.subject.trim()) throw new FduError('BAD_ARGS', '主题不能为空。', '用 --subject 写主题。');
  if (/[\r\n]/.test(mail.subject) || mail.subject.length > 300) throw new FduError('BAD_ARGS', '主题不能换行，也不能超过 300 个字符。', '把主题改短，写在一行里。');
  if (mail.fromName !== undefined && (/[\r\n"<>]/.test(mail.fromName) || mail.fromName.length > 60)) throw new FduError('BAD_ARGS', '发件人显示名不能换行、不能含引号或尖括号，也不能超过 60 个字符。', '改用简单的名字，或不写 --from-name。');
  if (!mail.text.trim()) throw new FduError('BAD_ARGS', '正文不能为空。', '用 --text 或 --text-file 写正文。');
  if (mail.text.length > MAX_MAIL_TEXT_CHARS) throw new FduError('BAD_ARGS', `正文不能超过 ${MAX_MAIL_TEXT_CHARS} 个字符。`, '长内容改用附件（--file）。');
  if (mail.attachment && mail.attachment.data.byteLength > MAX_MAIL_ATTACHMENT_BYTES) throw new FduError('BAD_ARGS', '附件不能超过 20 MB。', '大文件请用网页邮箱的超大附件或网盘链接。');
}

// 这些阶段出错时，服务器还没有开始接收正文：可以确定邮件没有发出
const BEFORE_DATA = /^(CONN|EHLO|HELO|LHLO|STARTTLS|AUTH|MAIL FROM|RCPT TO)/i;
const NOT_SENT_CODES = new Set(['EAUTH', 'ECONNECTION', 'EDNS', 'ETLS', 'EENVELOPE', 'EMESSAGE']);

function sendError(error: unknown, user: string): FduError {
  if (error instanceof FduError) return error;
  const e = error as { code?: string; command?: string; responseCode?: number };
  const code = e.responseCode ? `（SMTP ${e.responseCode}）` : '';
  if (e.code === 'EAUTH') return new FduError('NEED_MAIL_SETUP', `邮箱发信认证失败${code}，邮件没有发出。`, `确认 ${user} 的客户端专用密码仍有效，并在网页邮箱设置里开启了 IMAP/SMTP 服务；需要时重新运行 \`fdu mail setup --user ${user}\`。`);
  if (e.code === 'EENVELOPE') return new FduError('BAD_ARGS', `服务器拒绝了收件人或发件人${code}，邮件没有发出。`, '检查收件人地址是否拼写正确；外部域名被拒时可在网页邮箱确认发信权限。');
  if (e.code === 'EMESSAGE') return new FduError('BAD_ARGS', '邮件内容无法生成，邮件没有发出。', '检查主题、正文和附件。');
  if (NOT_SENT_CODES.has(e.code ?? '') || BEFORE_DATA.test(e.command ?? '')) {
    return new FduError('UPSTREAM', `连接发信服务器失败${code}，邮件没有发出。`, '检查网络、发信服务器和端口（默认 smtp.exmail.qq.com:465）后再发。');
  }
  return new FduError('MAIL_UNKNOWN', `已尝试发送邮件，但无法确认服务器是否接收${code}；没有自动重试。`, '先运行 `fdu mail list --folder sent --days 1` 或在网页邮箱的「已发送」里核对，确认没有发出后再重发，避免对方收到两封。');
}

/** SMTP 发信：每次一封，发完断开；不自动重试，不读取本机文件或网络地址作为附件。 */
export class SmtpMailSender {
  constructor(private readonly config: SmtpConfig, private readonly createClient?: () => SmtpTransport) {}

  private connect(): SmtpTransport {
    if (this.createClient) return this.createClient();
    return createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.port === 465,
      requireTLS: this.config.port !== 465,
      auth: { user: this.config.user, pass: this.config.password },
      connectionTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
      // 附件只来自内存里的数据，不让邮件内容去读本机文件或抓取网址
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    }) as unknown as SmtpTransport;
  }

  preview(mail: OutgoingMail) {
    checkOutgoing(mail);
    return {
      from: mail.fromName ? `${mail.fromName} <${this.config.user}>` : this.config.user,
      to: mail.to, cc: mail.cc, bcc: mail.bcc,
      subject: mail.subject,
      text: mail.text,
      attachment: mail.attachment ? { name: mail.attachment.name, bytes: mail.attachment.data.byteLength } : null,
      inReplyTo: mail.inReplyTo ?? null,
      server: `${this.config.host}:${this.config.port}`,
    };
  }

  async send(mail: OutgoingMail, opts: { dryRun?: boolean } = {}) {
    const preview = this.preview(mail);
    if (opts.dryRun) return { dryRun: true, sent: false, ...preview };
    const client = this.connect();
    let info: SmtpSendInfo;
    try {
      info = await client.sendMail({
        from: mail.fromName ? { name: mail.fromName, address: this.config.user } : this.config.user,
        to: mail.to,
        ...(mail.cc.length ? { cc: mail.cc } : {}),
        ...(mail.bcc.length ? { bcc: mail.bcc } : {}),
        subject: mail.subject,
        text: mail.text,
        ...(mail.attachment ? { attachments: [{ filename: mail.attachment.name, content: Buffer.from(mail.attachment.data) }] } : {}),
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.references?.length ? mail.references : [mail.inReplyTo] } : {}),
      });
    } catch (error) {
      throw sendError(error, this.config.user);
    } finally {
      try { client.close?.(); } catch { /* 断开失败不影响结果 */ }
    }
    const accepted = (info.accepted ?? []).map(address);
    const rejected = (info.rejected ?? []).map(address);
    const wanted = [...mail.to, ...mail.cc, ...mail.bcc].map((a) => a.toLowerCase());
    const acceptedSet = new Set(accepted.map((a) => a.toLowerCase()));
    return {
      dryRun: false,
      sent: accepted.length > 0,
      // 只有服务器明确接收了全部收件人才算核验通过；送达对方信箱仍取决于对方服务器
      verified: rejected.length === 0 && wanted.every((a) => acceptedSet.has(a)),
      messageId: info.messageId ?? null,
      accepted,
      rejected,
      response: info.response ?? null,
      ...preview,
    };
  }
}
