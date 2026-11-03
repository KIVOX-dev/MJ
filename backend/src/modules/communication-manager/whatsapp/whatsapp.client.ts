export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<{ messageId: string }>;
}

/** Meta WhatsApp Cloud API client: POST /{phone-number-id}/messages */
export class WhatsAppCloudClient implements WhatsAppSender {
  constructor(
    private readonly opts: { accessToken: string; phoneNumberId: string; apiVersion: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async sendText(to: string, body: string): Promise<{ messageId: string }> {
    const res = await this.fetchFn(
      `https://graph.facebook.com/${this.opts.apiVersion}/${this.opts.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          // WhatsApp text limit is 4096 chars
          text: { body: body.slice(0, 4000) },
        }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id: string }>;
      error?: { message?: string; code?: number };
    };
    // Verify the API actually accepted it; never assume success.
    const id = json.messages?.[0]?.id;
    if (!res.ok || !id) {
      throw new Error(`WhatsApp send failed (HTTP ${res.status}, code ${json.error?.code ?? 'n/a'}): ${json.error?.message ?? 'no message id returned'}`);
    }
    return { messageId: id };
  }
}
