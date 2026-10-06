import type { IceServerResponse } from './types';

export const backendUrl = (import.meta.env.VITE_SIGNALING_URL || (import.meta.env.DEV ? 'http://localhost:10000' : '')).replace(/\/$/, '');
export const appBase = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export function roomPath(roomId: string): string {
  return `${appBase}/sala/${roomId}` || `/sala/${roomId}`;
}

export async function getIceServers(): Promise<RTCIceServer[]> {
  if (backendUrl) {
    try {
      const response = await fetch(`${backendUrl}/api/ice-servers`);
      if (response.ok) {
        const config = await response.json() as IceServerResponse;
        if (config.iceServers?.length) return config.iceServers;
      }
    } catch {
      // STUN remains available if the optional TURN configuration endpoint cannot be reached.
    }
  }

  return [{ urls: 'stun:stun.l.google.com:19302' }];
}
