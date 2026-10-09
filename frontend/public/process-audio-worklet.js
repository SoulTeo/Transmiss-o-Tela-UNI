class ProcessAudioQueue extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = [];
    this.current = null;
    this.offset = 0;
    this.port.onmessage = ({ data }) => {
      if (!(data instanceof ArrayBuffer)) return;
      this.blocks.push(new Float32Array(data));
      if (this.blocks.length > 40) this.blocks.splice(0, 12);
    };
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (!channels || channels.length < 2) return true;
    const left = channels[0];
    const right = channels[1];
    left.fill(0);
    right.fill(0);

    for (let frame = 0; frame < left.length; frame += 1) {
      while (!this.current || this.offset >= this.current.length) {
        this.current = this.blocks.shift() || null;
        this.offset = 0;
        if (!this.current) break;
      }
      if (!this.current) break;
      left[frame] = this.current[this.offset++];
      right[frame] = this.current[this.offset++];
    }
    return true;
  }
}

registerProcessor('process-audio-queue', ProcessAudioQueue);
