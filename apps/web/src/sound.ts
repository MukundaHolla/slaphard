let audioContext: AudioContext | null = null;

const getAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const Ctx =
    window.AudioContext ||
    ((window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null);

  if (!Ctx) {
    return null;
  }

  if (!audioContext) {
    audioContext = new Ctx();
  }

  if (audioContext.state === 'suspended') {
    void audioContext.resume();
  }

  return audioContext;
};

const playTone = (frequency: number, durationMs: number, gain = 0.05, type: OscillatorType = 'sine'): void => {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }

  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = type;
  oscillator.frequency.value = frequency;

  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start();
  oscillator.stop(ctx.currentTime + durationMs / 1000 + 0.02);
};

export const playClickSound = (): void => {
  playTone(420, 55, 0.03, 'triangle');
};

export const playFlipSound = (): void => {
  playTone(260, 70, 0.05, 'square');
  setTimeout(() => playTone(340, 80, 0.04, 'square'), 30);
};

export const playSlapSound = (): void => {
  playTone(150, 30, 0.08, 'sawtooth');
  setTimeout(() => playTone(110, 40, 0.06, 'sawtooth'), 18);
};
