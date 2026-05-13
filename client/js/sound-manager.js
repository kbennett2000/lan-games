'use strict';

/**
 * sound-manager.js
 *
 * Synthesized sound effects using the Web Audio API — no audio files required.
 * All sounds are generated procedurally from oscillators and noise buffers.
 *
 * Public API:
 *   SoundManager.playCollect()     — small money received (rent, card collect)
 *   SoundManager.playBigCollect()  — passing Go, auction win
 *   SoundManager.playPay(big)      — paying out money; big=true for dramatic version
 *   SoundManager.playDice()        — dice roll rattle
 *   SoundManager.playBuy()         — property purchased
 *   SoundManager.playJail()        — sent to jail
 *   SoundManager.playFreeJail()    — released from jail
 *   SoundManager.playCard()        — chance / community chest draw
 *   SoundManager.playBuild()       — house / hotel built
 *   SoundManager.playMonopoly()    — monopoly achieved fanfare
 *   SoundManager.playBankrupt()    — player goes bankrupt
 *   SoundManager.playGameOver()    — game-over fanfare
 *   SoundManager.toggle()          — mute / unmute; returns new enabled state
 *   SoundManager.isEnabled()
 */

const SoundManager = (() => {

  let _ac      = null;
  let _enabled = true;

  // Lazily create AudioContext and resume it (browsers require a user gesture first).
  function ac() {
    if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
    if (_ac.state === 'suspended') _ac.resume();
    return _ac;
  }

  // ── low-level primitives ───────────────────────────────────────────────────

  /**
   * Play a single oscillator tone with a percussive envelope.
   * freqEnd: if set, slide the pitch to this frequency over `dur`.
   */
  function tone(a, freq, start, dur, type = 'sine', vol = 0.25, freqEnd = null) {
    const osc  = a.createOscillator();
    const gain = a.createGain();
    osc.connect(gain);
    gain.connect(a.destination);

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), start + dur);
    }

    // Sharp attack, exponential decay
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.linearRampToValueAtTime(vol, start + 0.008);
    gain.gain.setValueAtTime(vol, start + dur * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  /** Short burst of filtered white noise — for dice, construction, card flips. */
  function noise(a, start, dur, filterFreq = 2000, vol = 0.12) {
    const len  = Math.ceil(a.sampleRate * dur);
    const buf  = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const src    = a.createBufferSource();
    src.buffer   = buf;

    const filter      = a.createBiquadFilter();
    filter.type       = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value    = 1.2;

    const gain = a.createGain();
    src.connect(filter);
    filter.connect(gain);
    gain.connect(a.destination);

    gain.gain.setValueAtTime(vol, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

    src.start(start);
    src.stop(start + dur + 0.02);
  }

  /** Wrap a sound function so it only runs when enabled, swallowing errors. */
  function play(fn) {
    if (!_enabled) return;
    try { fn(ac()); } catch (e) { console.warn('[sound]', e); }
  }

  // ── sound effects ──────────────────────────────────────────────────────────

  /**
   * Small collect: bright ascending coin cascade (C–E–G–C).
   * Used for: small rent received, collect cards, freed from jail.
   */
  function playCollect() {
    play(a => {
      const t = a.currentTime;
      [523, 659, 784, 1047].forEach((f, i) =>
        tone(a, f, t + i * 0.07, 0.18, 'sine', 0.26)
      );
    });
  }

  /**
   * Big collect: elaborate ascending fanfare with a final chord shimmer.
   * Used for: passing Go, auction win, large rent received.
   */
  function playBigCollect() {
    play(a => {
      const t = a.currentTime;
      // Coin cascade — faster and one note higher
      [523, 659, 784, 1047, 1319].forEach((f, i) =>
        tone(a, f, t + i * 0.065, 0.2, 'sine', 0.28)
      );
      // Sustain chord underneath
      [523, 659, 784].forEach(f =>
        tone(a, f, t + 0.38, 0.55, 'sine', 0.14)
      );
      // Sparkle on top
      tone(a, 2093, t + 0.38, 0.3, 'sine', 0.08);
    });
  }

  /**
   * Pay sound: descending minor-ish tones.
   * big=true adds a heavy low thud for dramatic effect (large rent, tax).
   */
  function playPay(big = false) {
    play(a => {
      const t = a.currentTime;
      if (big) {
        // Heavy thud
        tone(a, 90, t, 0.35, 'triangle', 0.45, 40);
        noise(a, t, 0.15, 300, 0.1);
      }
      const offset = big ? 0.12 : 0;
      // Sad descending tones (G–F–Eb–C)
      [392, 349, 311, 261].forEach((f, i) =>
        tone(a, f, t + offset + i * 0.09, 0.22, big ? 'sawtooth' : 'sine', big ? 0.2 : 0.25)
      );
      if (big) {
        // Extra low note to drive it home
        tone(a, 196, t + offset + 4 * 0.09, 0.4, 'sine', 0.2);
      }
    });
  }

  /**
   * Dice roll: two quick noise bursts like dice clattering on a table.
   */
  function playDice() {
    play(a => {
      const t = a.currentTime;
      noise(a, t,        0.07, 4000, 0.14);
      noise(a, t + 0.1,  0.07, 4000, 0.14);
      noise(a, t + 0.17, 0.05, 3000, 0.09);
    });
  }

  /**
   * Property bought: two ascending "ding" tones (register-like).
   */
  function playBuy() {
    play(a => {
      const t = a.currentTime;
      tone(a, 880,  t,       0.12, 'sine', 0.22);
      tone(a, 1047, t + 0.1, 0.18, 'sine', 0.22);
    });
  }

  /**
   * Jail: metallic clang + low pitch slide (bars slamming).
   */
  function playJail() {
    play(a => {
      const t = a.currentTime;
      // Clang hit
      tone(a, 220, t,       0.05, 'square',   0.3);
      tone(a, 160, t + 0.05, 0.5, 'triangle', 0.22, 60);
      // Rattle
      noise(a, t, 0.12, 600, 0.1);
      noise(a, t + 0.08, 0.08, 400, 0.07);
    });
  }

  /**
   * Freed from jail: quick bright arpeggio (relief).
   */
  function playFreeJail() {
    play(a => {
      const t = a.currentTime;
      [392, 523, 659, 784].forEach((f, i) =>
        tone(a, f, t + i * 0.07, 0.15, 'sine', 0.22)
      );
    });
  }

  /**
   * Card drawn: brief paper-shuffle noise + soft chime.
   */
  function playCard() {
    play(a => {
      const t = a.currentTime;
      noise(a, t,       0.07, 5000, 0.07);
      noise(a, t + 0.04, 0.05, 3000, 0.05);
      tone(a, 1047, t + 0.06, 0.18, 'sine', 0.15);
    });
  }

  /**
   * Building built: woody thud + ascending "pop".
   */
  function playBuild() {
    play(a => {
      const t = a.currentTime;
      noise(a, t,       0.06, 700, 0.12);
      tone(a, 440, t + 0.05, 0.1,  'triangle', 0.18);
      tone(a, 587, t + 0.12, 0.14, 'sine',     0.2);
    });
  }

  /**
   * Monopoly achieved: da-da-da-DAA with a held chord.
   */
  function playMonopoly() {
    play(a => {
      const t = a.currentTime;
      tone(a, 523, t,       0.12, 'sine', 0.3);
      tone(a, 523, t + 0.14, 0.12, 'sine', 0.3);
      tone(a, 523, t + 0.28, 0.12, 'sine', 0.3);
      // Big final note with harmony
      tone(a, 659, t + 0.42, 0.55, 'sine', 0.35);
      tone(a, 784, t + 0.42, 0.55, 'sine', 0.25);
      tone(a, 1047, t + 0.42, 0.55, 'sine', 0.18);
    });
  }

  /**
   * Bankrupt: sad descending sawtooth (trombone-like) + low drone.
   */
  function playBankrupt() {
    play(a => {
      const t = a.currentTime;
      [440, 392, 349, 311, 277, 261].forEach((f, i) =>
        tone(a, f, t + i * 0.13, 0.26, 'sawtooth', 0.18)
      );
      // Low sustained drone
      tone(a, 65, t + 0.2, 1.0, 'triangle', 0.22);
    });
  }

  /**
   * Game over: triumphant ascending fanfare + final major chord.
   */
  function playGameOver() {
    play(a => {
      const t = a.currentTime;
      [523, 659, 784, 1047, 1319].forEach((f, i) =>
        tone(a, f, t + i * 0.11, 0.22, 'sine', 0.3)
      );
      // Held final chord
      [523, 659, 784, 1047].forEach(f =>
        tone(a, f, t + 0.7, 1.0, 'sine', 0.18)
      );
    });
  }

  // ── controls ───────────────────────────────────────────────────────────────

  function toggle() {
    _enabled = !_enabled;
    return _enabled;
  }

  function isEnabled() {
    return _enabled;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  return {
    playCollect,
    playBigCollect,
    playPay,
    playDice,
    playBuy,
    playJail,
    playFreeJail,
    playCard,
    playBuild,
    playMonopoly,
    playBankrupt,
    playGameOver,
    toggle,
    isEnabled,
  };

})();
