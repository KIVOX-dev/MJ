// The frontend only talks to the MJ backend. Never call Groq/Gmail/WhatsApp from the browser.
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export async function getReady(): Promise<{ status: string; db: boolean }> {
  const res = await fetch(`${API_URL}/ready`);
  return res.json();
}
