type SoundKey = 'click' | 'flip' | 'slap' | 'penalty' | 'win' | 'sad' | 'cheer';

const SOUND_SPECS: Record<SoundKey, { path: string; volume: number }> = {
  click: { path: '/sfx/click.wav', volume: 0.4 },
  flip: { path: '/sfx/flip.wav', volume: 0.55 },
  slap: { path: '/sfx/slap.wav', volume: 0.65 },
  penalty: { path: '/sfx/penalty.wav', volume: 0.6 },
  win: { path: '/sfx/win.wav', volume: 0.65 },
  sad: { path: '/sfx/sad.wav', volume: 0.62 },
  cheer: { path: '/sfx/cheer.wav', volume: 0.68 },
};

class AudioEngine {
  private unlocked = false;
  private readonly baseAudio: Partial<Record<SoundKey, HTMLAudioElement>> = {};

  preload(): void {
    for (const [key, spec] of Object.entries(SOUND_SPECS) as Array<[SoundKey, { path: string; volume: number }]>) {
      const audio = new Audio(spec.path);
      audio.preload = 'auto';
      audio.volume = spec.volume;
      void audio.load();
      this.baseAudio[key] = audio;
    }
  }

  unlock(): void {
    if (this.unlocked) {
      return;
    }

    this.unlocked = true;
    const click = this.baseAudio.click;
    if (!click) {
      return;
    }

    const clone = click.cloneNode(true) as HTMLAudioElement;
    clone.volume = 0;
    void clone.play().catch(() => {
      // Safari and strict autoplay policies may still block here until later user input.
    });
  }

  play(key: SoundKey): void {
    const base = this.baseAudio[key];
    if (!base) {
      return;
    }

    const sample = base.cloneNode(true) as HTMLAudioElement;
    sample.volume = base.volume;
    sample.currentTime = 0;
    void sample.play().catch(() => {
      // Silently ignore playback failures so UX remains stable.
    });
  }
}

const engine = new AudioEngine();

export const initAudio = (): void => {
  engine.preload();
};

export const unlockAudio = (): void => {
  engine.unlock();
};

export const playClickSound = (): void => {
  engine.play('click');
};

export const playFlipSound = (): void => {
  engine.play('flip');
};

export const playSlapSound = (): void => {
  engine.play('slap');
};

export const playPenaltySound = (): void => {
  engine.play('penalty');
};

export const playWinSound = (): void => {
  engine.play('win');
};

export const playSadSound = (): void => {
  engine.play('sad');
};

export const playCheerSound = (): void => {
  engine.play('cheer');
};
