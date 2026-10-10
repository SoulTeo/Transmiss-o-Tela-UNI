import type { Socket } from 'socket.io-client';

export type PeerMetric = {
  peerId: string;
  connectionState: string;
  iceState: string;
  bitrate: number | null;
  rtt: number | null;
  jitter: number | null;
  loss: number | null;
  fps: number | null;
  resolution: string | null;
  codec: string | null;
  encoder: string | null;
  qualityLimitationReason: string | null;
};

type PeerRecord = {
  pc: RTCPeerConnection;
  retryTimer: number | null;
  disconnectedTimer: number | null;
  statsTimer: number | null;
  retryCount: number;
  stableTimer: number | null;
  qualityLevel: number;
  badSamples: number;
  stableSamples: number;
  bytesSent: number | null;
  lastBytesAt: number | null;
};

type PeerMeshOptions = {
  socket: Socket;
  participantId: string;
  iceServers: RTCIceServer[];
  onTrack: (track: MediaStreamTrack) => void;
  onTrackEnded: (track: MediaStreamTrack) => void;
  onPeerRemoved: (peerId: string) => void;
  onMetric: (metric: PeerMetric) => void;
  onRecoveryLimit: (peerId: string) => void;
};

const MAX_RECOVERY_ATTEMPTS = 5;
type RemoteInboundVideoStats = RTCStats & { kind?: string; roundTripTime?: number; jitter?: number; fractionLost?: number };

export class PeerMesh {
  private readonly socket: Socket;
  private readonly participantId: string;
  private readonly iceServers: RTCIceServer[];
  private readonly callbacks: Pick<PeerMeshOptions, 'onTrack' | 'onTrackEnded' | 'onPeerRemoved' | 'onMetric' | 'onRecoveryLimit'>;
  private readonly peers = new Map<string, PeerRecord>();
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly recoveryTimers = new Map<string, number>();
  private readonly recoveryAttempts = new Map<string, number>();
  private localStream: MediaStream | null = null;
  private sharerId: string | null = null;
  private disposed = false;

  constructor(options: PeerMeshOptions) {
    this.socket = options.socket;
    this.participantId = options.participantId;
    this.iceServers = options.iceServers;
    this.callbacks = options;
  }

  setSharer(sharerId: string | null) {
    this.sharerId = sharerId;
  }

  async startSharing(stream: MediaStream, participantIds: string[]) {
    this.localStream = stream;
    this.sharerId = this.participantId;
    await Promise.all(participantIds.filter((id) => id !== this.participantId).map((id) => this.createOffer(id)));
  }

  async addParticipant(participantId: string) {
    if (!this.isSharer() || participantId === this.participantId || this.peers.has(participantId)) return;
    await this.createOffer(participantId);
  }

  async receiveOffer(fromParticipantId: string, description: RTCSessionDescriptionInit) {
    if (this.isSharer() || this.sharerId !== fromParticipantId || this.disposed) return;
    const record = this.createPeer(fromParticipantId);
    try {
      await record.pc.setRemoteDescription(description);
      await this.flushCandidates(fromParticipantId, record);
      const answer = await record.pc.createAnswer();
      await record.pc.setLocalDescription(answer);
      this.socket.emit('signal:answer', {
        targetId: fromParticipantId,
        description: record.pc.localDescription?.toJSON() || answer,
      });
    } catch (error) {
      console.warn('[webrtc] não foi possível responder à offer', error);
      this.scheduleRecovery(fromParticipantId, true);
    }
  }

  async receiveAnswer(fromParticipantId: string, description: RTCSessionDescriptionInit) {
    if (!this.isSharer()) return;
    const record = this.peers.get(fromParticipantId);
    if (!record || record.pc.signalingState === 'closed') return;
    try {
      await record.pc.setRemoteDescription(description);
      await this.flushCandidates(fromParticipantId, record);
    } catch (error) {
      console.warn('[webrtc] resposta SDP inválida', error);
      this.scheduleRecovery(fromParticipantId, true);
    }
  }

  async receiveIce(fromParticipantId: string, candidate: RTCIceCandidateInit) {
    const record = this.peers.get(fromParticipantId);
    if (!record || !record.pc.remoteDescription) {
      const pending = this.pendingCandidates.get(fromParticipantId) || [];
      if (pending.length < 128) pending.push(candidate);
      this.pendingCandidates.set(fromParticipantId, pending);
      return;
    }
    try {
      await record.pc.addIceCandidate(candidate);
    } catch (error) {
      console.debug('[webrtc] candidato ICE ignorado', error);
    }
  }

  receiveRestart(fromParticipantId: string) {
    if (this.isSharer()) this.scheduleRecovery(fromParticipantId, false);
  }

  removeParticipant(participantId: string) {
    this.closePeer(participantId);
    this.pendingCandidates.delete(participantId);
    const recoveryTimer = this.recoveryTimers.get(participantId);
    if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer);
    this.recoveryTimers.delete(participantId);
    this.recoveryAttempts.delete(participantId);
    this.callbacks.onPeerRemoved(participantId);
  }

  stopSharing() {
    this.localStream = null;
    if (this.isSharer()) this.sharerId = null;
    this.closeAllPeers();
  }

  closeAllPeers() {
    for (const peerId of [...this.peers.keys()]) {
      this.closePeer(peerId);
      this.callbacks.onPeerRemoved(peerId);
    }
    this.pendingCandidates.clear();
    for (const timer of this.recoveryTimers.values()) window.clearTimeout(timer);
    this.recoveryTimers.clear();
    this.recoveryAttempts.clear();
  }

  dispose() {
    this.disposed = true;
    this.localStream = null;
    this.closeAllPeers();
  }

  private isSharer() {
    return this.sharerId === this.participantId;
  }

  private async createOffer(peerId: string, iceRestart = false) {
    if (!this.isSharer() || !this.localStream || this.disposed) return;
    const record = this.createPeer(peerId);
    this.localStream.getTracks().forEach((track) => record.pc.addTrack(track, this.localStream!));
    await this.applyRoomBudget();
    try {
      const offer = await record.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await record.pc.setLocalDescription(offer);
      this.socket.emit('signal:offer', {
        targetId: peerId,
        description: record.pc.localDescription?.toJSON() || offer,
      });
    } catch (error) {
      console.warn('[webrtc] não foi possível criar offer', error);
      this.scheduleRecovery(peerId, true);
    }
  }

  private createPeer(peerId: string): PeerRecord {
    this.closePeer(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const record: PeerRecord = {
      pc,
      retryTimer: null,
      disconnectedTimer: null,
      statsTimer: null,
      retryCount: this.recoveryAttempts.get(peerId) || 0,
      stableTimer: null,
      qualityLevel: 0,
      badSamples: 0,
      stableSamples: 0,
      bytesSent: null,
      lastBytesAt: null,
    };
    this.peers.set(peerId, record);
    pc.onicecandidate = (event) => {
      if (event.candidate) this.socket.emit('signal:ice', { targetId: peerId, description: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      this.callbacks.onTrack(event.track);
      event.track.addEventListener('ended', () => this.callbacks.onTrackEnded(event.track), { once: true });
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(peerId) !== record) return;
      if (pc.connectionState === 'connected') {
        if (record.disconnectedTimer !== null) window.clearTimeout(record.disconnectedTimer);
        record.disconnectedTimer = null;
        if (record.stableTimer !== null) window.clearTimeout(record.stableTimer);
        record.stableTimer = window.setTimeout(() => {
          if (this.peers.get(peerId) === record && pc.connectionState === 'connected') {
            record.retryCount = 0;
            this.recoveryAttempts.delete(peerId);
          }
        }, 10_000);
      } else if (pc.connectionState === 'failed') {
        this.scheduleRecovery(peerId, true);
      } else if (pc.connectionState === 'disconnected' && record.disconnectedTimer === null) {
        record.disconnectedTimer = window.setTimeout(() => {
          record.disconnectedTimer = null;
          if (this.peers.get(peerId) === record && pc.connectionState !== 'connected') this.scheduleRecovery(peerId, true);
        }, 5_000);
      }
    };
    record.statsTimer = window.setInterval(() => void this.collectStats(peerId, record), 2_000);
    return record;
  }

  private async flushCandidates(peerId: string, record: PeerRecord) {
    const candidates = this.pendingCandidates.get(peerId) || [];
    this.pendingCandidates.delete(peerId);
    for (const candidate of candidates) {
      try {
        await record.pc.addIceCandidate(candidate);
      } catch (error) {
        console.debug('[webrtc] candidato ICE pendente ignorado', error);
      }
    }
  }

  private scheduleRecovery(peerId: string, attemptNow: boolean) {
    if (this.disposed || !this.sharerId || peerId === this.participantId) return;
    if (this.recoveryTimers.has(peerId)) return;
    const existing = this.peers.get(peerId);
    const attempts = (this.recoveryAttempts.get(peerId) || 0) + 1;
    if (attempts > MAX_RECOVERY_ATTEMPTS) {
      this.callbacks.onRecoveryLimit(peerId);
      return;
    }
    this.recoveryAttempts.set(peerId, attempts);
    if (existing) existing.retryCount = attempts;
    const delay = attemptNow && attempts === 1 ? 0 : Math.min(8_000, 500 * (2 ** (attempts - 1)));
    const timer = window.setTimeout(() => {
      this.recoveryTimers.delete(peerId);
      const current = this.peers.get(peerId);
      if (current) current.retryTimer = null;
      if (this.disposed || !this.sharerId) return;
      if (this.isSharer()) {
        void this.createOffer(peerId, true);
      } else {
        this.closePeer(peerId);
        this.socket.emit('signal:restart', { targetId: this.sharerId });
      }
    }, delay);
    this.recoveryTimers.set(peerId, timer);
    if (existing) existing.retryTimer = timer;
  }

  private closePeer(peerId: string) {
    const record = this.peers.get(peerId);
    if (record) {
      this.peers.delete(peerId);
      if (record.retryTimer !== null) window.clearTimeout(record.retryTimer);
      if (record.disconnectedTimer !== null) window.clearTimeout(record.disconnectedTimer);
      if (record.stableTimer !== null) window.clearTimeout(record.stableTimer);
      if (record.statsTimer !== null) window.clearInterval(record.statsTimer);
      record.pc.onicecandidate = null;
      record.pc.ontrack = null;
      record.pc.onconnectionstatechange = null;
      record.pc.close();
    }
    const recoveryTimer = this.recoveryTimers.get(peerId);
    if (recoveryTimer !== undefined) window.clearTimeout(recoveryTimer);
    this.recoveryTimers.delete(peerId);
  }

  private async collectStats(peerId: string, record: PeerRecord) {
    if (this.peers.get(peerId) !== record) return;
    try {
      const reports = await record.pc.getStats();
      let videoReport: RTCStats | undefined;
      let inboundVideo: RTCInboundRtpStreamStats | undefined;
      let outboundVideo: RTCOutboundRtpStreamStats | undefined;
      let remoteInbound: RemoteInboundVideoStats | undefined;
      let jitter: number | null = null;
      let loss: number | null = null;
      let rtt: number | null = null;
      let codec: string | null = null;
      let encoder: string | null = null;
      let qualityLimitationReason: string | null = null;
      let fps: number | null = null;
      let resolution: string | null = null;

      reports.forEach((report) => {
        if ((report.type === 'inbound-rtp' || report.type === 'outbound-rtp') && report.kind === 'video') {
          videoReport = report;
          if (report.type === 'inbound-rtp') inboundVideo = report as RTCInboundRtpStreamStats;
          if (report.type === 'outbound-rtp') outboundVideo = report as RTCOutboundRtpStreamStats;
        }
        if (report.type === 'remote-inbound-rtp' && ('kind' in report ? report.kind === 'video' : true)) remoteInbound = report as RemoteInboundVideoStats;
      });
      const selectedReport = outboundVideo || inboundVideo;
      if (selectedReport?.codecId) {
        const codecReport = reports.get(selectedReport.codecId);
        if (codecReport && 'mimeType' in codecReport) codec = String(codecReport.mimeType);
      }
      if (inboundVideo) {
        jitter = typeof inboundVideo.jitter === 'number' && Number.isFinite(inboundVideo.jitter) ? inboundVideo.jitter : null;
        const received = inboundVideo.packetsReceived || 0;
        const lost = Math.max(0, inboundVideo.packetsLost || 0);
        loss = received + lost > 0 ? lost / (received + lost) : null;
      }
      if (remoteInbound) {
        rtt = typeof remoteInbound.roundTripTime === 'number' && Number.isFinite(remoteInbound.roundTripTime) ? remoteInbound.roundTripTime : null;
        if (typeof remoteInbound.jitter === 'number' && Number.isFinite(remoteInbound.jitter)) jitter = remoteInbound.jitter;
        if (typeof remoteInbound.fractionLost === 'number' && Number.isFinite(remoteInbound.fractionLost)) loss = remoteInbound.fractionLost;
      }
      if (outboundVideo) {
        qualityLimitationReason = 'qualityLimitationReason' in outboundVideo ? String(outboundVideo.qualityLimitationReason || 'none') : null;
        fps = typeof outboundVideo.framesPerSecond === 'number' && Number.isFinite(outboundVideo.framesPerSecond) ? outboundVideo.framesPerSecond : null;
        encoder = 'encoderImplementation' in outboundVideo ? String(outboundVideo.encoderImplementation) : null;
        if (outboundVideo.frameWidth && outboundVideo.frameHeight) resolution = `${outboundVideo.frameWidth}×${outboundVideo.frameHeight}`;
      } else if (inboundVideo) {
        fps = typeof inboundVideo.framesPerSecond === 'number' && Number.isFinite(inboundVideo.framesPerSecond) ? inboundVideo.framesPerSecond : null;
        if (inboundVideo.frameWidth && inboundVideo.frameHeight) resolution = `${inboundVideo.frameWidth}×${inboundVideo.frameHeight}`;
      }

      let bitrate: number | null = null;
      const bytes = outboundVideo?.bytesSent ?? inboundVideo?.bytesReceived;
      const now = Date.now();
      if (typeof bytes === 'number' && record.bytesSent !== null && record.lastBytesAt !== null && now > record.lastBytesAt) {
        bitrate = Math.max(0, ((bytes - record.bytesSent) * 8_000) / (now - record.lastBytesAt));
      }
      if (typeof bytes === 'number') {
        record.bytesSent = bytes;
        record.lastBytesAt = now;
      }

      if (this.isSharer() && outboundVideo) await this.adaptVideo(peerId, record, loss, rtt, jitter, qualityLimitationReason);
      this.callbacks.onMetric({
        peerId,
        connectionState: record.pc.connectionState,
        iceState: record.pc.iceConnectionState,
        bitrate,
        rtt,
        jitter,
        loss,
        fps,
        resolution,
        codec,
        encoder,
        qualityLimitationReason,
      });
      void videoReport;
    } catch (error) {
      console.debug('[webrtc] getStats não disponível para um peer', error);
    }
  }

  private async adaptVideo(peerId: string, record: PeerRecord, loss: number | null, rtt: number | null, jitter: number | null, limitation: string | null) {
    const videoSender = record.pc.getSenders().find((sender) => sender.track?.kind === 'video');
    if (!videoSender) return;
    const bad = (loss !== null && loss > 0.05)
      || (rtt !== null && rtt > 0.4)
      || (jitter !== null && jitter > 0.04)
      || Boolean(limitation && limitation !== 'none');
    if (bad) {
      record.badSamples += 1;
      record.stableSamples = 0;
      if (record.badSamples >= 2 && record.qualityLevel < 3) {
        record.qualityLevel += 1;
        record.badSamples = 0;
        await this.applyVideoQuality(videoSender, record.qualityLevel);
      }
    } else {
      record.stableSamples += 1;
      record.badSamples = 0;
      if (record.stableSamples >= 5 && record.qualityLevel > 0) {
        record.qualityLevel -= 1;
        record.stableSamples = 0;
        await this.applyVideoQuality(videoSender, record.qualityLevel);
      }
    }
    if (this.peers.get(peerId) !== record) return;
  }

  private async applyRoomBudget() {
    const updates: Promise<void>[] = [];
    for (const record of this.peers.values()) {
      const videoSender = record.pc.getSenders().find((sender) => sender.track?.kind === 'video');
      if (videoSender) updates.push(this.applyVideoQuality(videoSender, record.qualityLevel));
    }
    await Promise.all(updates);
  }

  private async applyVideoQuality(sender: RTCRtpSender, level: number) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      const viewers = Math.max(1, this.peers.size);
      const sharedBudget = Math.min(4_000_000, Math.floor(12_000_000 / viewers));
      const encoding = parameters.encodings[0];
      encoding.maxBitrate = Math.floor(sharedBudget * (level >= 1 ? 0.7 : 1));
      encoding.scaleResolutionDownBy = level >= 2 ? 1.5 : 1;
      encoding.maxFramerate = level >= 3 ? 20 : 30;
      await sender.setParameters(parameters);
    } catch (error) {
      console.debug('[webrtc] navegador ignorou ajuste de qualidade', error);
    }
  }
}
