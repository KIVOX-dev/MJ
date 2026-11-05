export interface BrevoOptions {
  apiKey: string;
  senderEmail: string;
  senderName: string;
}

export interface EmailAttachment {
  name: string;
  data: Buffer;
}

/** Minimal Brevo transactional-email client (https://developers.brevo.com/reference/sendtransacemail). */
export class BrevoClient {
  constructor(
    private readonly o: BrevoOptions,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(to: string, subject: string, text: string, attachments: EmailAttachment[] = [], html?: string, opts: { replyTo?: string } = {}): Promise<{ messageId?: string }> {
    const res = await this.fetchFn('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.o.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: this.o.senderName, email: this.o.senderEmail },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
        ...(opts.replyTo ? { replyTo: { email: opts.replyTo } } : {}),
        ...(attachments.length ? { attachment: attachments.map((a) => ({ name: a.name, content: a.data.toString('base64') })) } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Brevo rejected the email (${res.status}) ${body}`.trim());
    }
    return (await res.json().catch(() => ({}))) as { messageId?: string };
  }
}
