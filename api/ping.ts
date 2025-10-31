// api/ping.ts
export default function handler(req: any, res: any) {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
}
