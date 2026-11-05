/**
 * HTML email for MJ. Table layout + inline CSS (works in Gmail, Outlook and phone mail apps),
 * no external images, readable in light and dark mode, and every piece of text is escaped (the body comes from an AI model).
 *
 * Two layouts:
 *  - to Sir himself: a coloured header with a square MJ badge, "Good day, Sir."
 *  - to someone else ("external"): a clean letter. The subject is the headline, no MJ band, and a small
 *    footer says it was sent by MJ on behalf of the owner. Replies go to the owner.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escaped text with **bold** and https:// links turned into markup. */
function inline(raw: string): string {
  return esc(raw)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (url) => `<a href="${url}" style="color:#6d28d9;text-decoration:underline;">${url}</a>`);
}

/** Same type as the MJ TIMES newspaper: Times-style serif for reading, Anek Tamil for labels. */
const SERIF = "'Times New Roman',Times,Georgia,serif";
const SANS = "'Anek Tamil','Arial Black',Arial,Helvetica,sans-serif";
const GRADIENT = 'background-color:#7c3aed;background-image:linear-gradient(135deg,#ff2fd0 0%,#8a1dff 52%,#1f6bff 100%);';

const P = `margin:0 0 14px 0;font-family:${SERIF};font-size:18px;line-height:1.6;color:#1e293b;`;

/** Plain text (paragraphs, "- " bullets, "1." lists) to email-safe HTML blocks. */
function blocks(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length && lines.every((l) => /^([-*•]|\d+[.)])\s+/.test(l))) {
        const ordered = /^\d/.test(lines[0]!);
        const tag = ordered ? 'ol' : 'ul';
        const items = lines.map((l) => `<li style="margin:0 0 6px 0;">${inline(l.replace(/^([-*•]|\d+[.)])\s+/, ''))}</li>`).join('');
        return `<${tag} style="margin:0 0 14px 0;padding-left:22px;font-family:${SERIF};font-size:18px;line-height:1.6;color:#1e293b;">${items}</${tag}>`;
      }
      return `<p style="${P}">${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

export interface EmailTemplateOptions {
  /** The headline. Defaults to the subject. */
  heading?: string;
  /** Small grey line shown in the inbox preview. */
  preheader?: string;
  /** Link-style button under the message. */
  button?: { label: string; url: string };
  date?: string;
  /** "external": for someone other than Sir. A clean letter with no "Good day, Sir" and a neutral footer. */
  audience?: 'owner' | 'external';
  /** Whose behalf an external email is sent on. */
  ownerName?: string;
}

export function renderEmailHtml(subject: string, body: string, o: EmailTemplateOptions = {}): string {
  const pre = esc((o.preheader ?? body.replace(/\s+/g, ' ').trim()).slice(0, 110));
  const external = o.audience === 'external';
  const button =
    o.button && /^https?:\/\//.test(o.button.url)
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px 0;"><tr><td align="center" bgcolor="#7c3aed" style="border-radius:12px;background:linear-gradient(135deg,#a21cff,#2a6bff);"><a href="${esc(o.button.url)}" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(o.button.label)}</a></td></tr></table>`
      : '';
  const date = o.date ? `<div style="font-family:${SANS};font-size:12px;color:#94a3b8;margin-top:2px;">${esc(o.date)}</div>` : '';
  const initials = esc((o.ownerName ?? 'MJ').split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase() || 'MJ');
  const heading = esc(o.heading ?? subject);
  const rule = (pad: string) => `<tr><td style="padding:${pad};"><div style="height:1px;background-color:#e2e8f0;line-height:1px;font-size:1px;">&nbsp;</div></td></tr>`;

  const letter = `<tr><td bgcolor="#7c3aed" height="6" style="height:6px;line-height:6px;font-size:0;${GRADIENT}">&nbsp;</td></tr>
        <tr>
          <td style="padding:30px 32px 8px 32px;">
            <h1 style="margin:0 0 20px 0;font-family:${SERIF};font-size:26px;line-height:1.25;font-weight:700;color:#0f172a;">${heading}</h1>
            ${blocks(body)}
            ${button}
          </td>
        </tr>
        ${rule('8px 32px 0 32px')}
        <tr>
          <td style="padding:16px 32px 28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="42" valign="top" style="width:42px;"><div style="width:34px;height:34px;line-height:34px;border-radius:17px;background-color:#ede9fe;color:#5b21b6;font-family:${SANS};font-size:13px;font-weight:800;text-align:center;">${initials}</div></td>
              <td valign="middle" style="font-family:${SANS};font-size:12.5px;line-height:1.5;color:#64748b;">Sent by <strong style="color:#6d28d9;">MJ</strong>, a personal assistant, on behalf of <strong style="color:#334155;">${esc(o.ownerName ?? 'its owner')}</strong>.<br>You can reply directly to this email.</td>
            </tr></table>
          </td>
        </tr>`;

  const own = `<tr>
          <td bgcolor="#7c3aed" style="padding:22px 24px;${GRADIENT}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="60" valign="top" style="width:60px;"><div style="width:48px;height:48px;line-height:48px;border-radius:14px;background-color:#12053a;font-family:${SANS};font-size:18px;font-weight:800;color:#ffffff;text-align:center;">MJ</div></td>
                <td valign="middle">
                  <div style="font-family:${SANS};font-size:11.5px;font-weight:700;letter-spacing:1.6px;color:rgba(255,255,255,0.88);text-transform:uppercase;">Your assistant</div>
                  <div style="font-family:${SERIF};font-size:22px;line-height:1.25;font-weight:700;color:#ffffff;margin-top:2px;">${heading}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 28px 8px 28px;">
            <p style="margin:0 0 16px 0;font-family:${SERIF};font-size:21px;font-weight:700;color:#0f172a;">Good day, Sir.</p>
            ${blocks(body)}
            ${button}
          </td>
        </tr>
        ${rule('0 28px')}
        <tr>
          <td style="padding:16px 28px 26px 28px;">
            <div style="font-family:${SANS};font-size:13px;line-height:1.5;color:#64748b;">Sent by <strong style="color:#6d28d9;">MJ</strong>, your personal intelligence assistant.</div>
            ${date}
            <div style="font-family:${SERIF};font-style:italic;font-size:13px;line-height:1.5;color:#94a3b8;margin-top:6px;">You are receiving this because you asked MJ to email you. Reply to chat with MJ on Telegram.</div>
          </td>
        </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Anek+Tamil:wght@400;600;800&display=swap" rel="stylesheet">
<style>@import url('https://fonts.googleapis.com/css2?family=Anek+Tamil:wght@400;600;800&display=swap');</style>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:${SERIF};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${pre}&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9" style="background-color:#f1f5f9;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:${external ? '16px' : '20px'};overflow:hidden;${external ? 'border:1px solid #e2e8f0;' : 'box-shadow:0 8px 30px rgba(15,23,42,0.08);'}">
        ${external ? letter : own}
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
