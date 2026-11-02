/** Wire format: timestamp (float64 LE milliseconds), then one stereo s16le PCM frame. */
export const COMPUTER_AUDIO = {
  version: 1,
  sampleRate: 48000,
  channels: 2,
  samplesPerFrame: 960,
  frameBytes: 3840,
  headerBytes: 8,
} as const;
export const COMPUTER_AUDIO_PORT = 5902;
export const COMPUTER_PULSE_SERVER = 'unix:/run/mukai-audio/native';
