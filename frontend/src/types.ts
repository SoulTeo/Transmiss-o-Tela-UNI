export type Participant = { id: string; name: string };
export type Route = { page: 'home' } | { page: 'room'; roomId: string };

export type ServerAck<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };
