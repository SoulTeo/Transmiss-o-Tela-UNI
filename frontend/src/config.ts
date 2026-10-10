export const backendUrl = (import.meta.env.VITE_SIGNALING_URL || import.meta.env.VITE_BACKEND_URL || (import.meta.env.DEV ? 'http://localhost:10000' : '')).replace(/\/$/, '');
export const appBase = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export function roomPath(roomId: string): string {
  return `${appBase}/sala/${roomId}` || `/sala/${roomId}`;
}
