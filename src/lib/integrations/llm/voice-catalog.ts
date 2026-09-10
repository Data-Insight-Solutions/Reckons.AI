/**
 * Static Kokoro voice metadata.
 *
 * Keep this separate from the synthesis adapter so the settings screen can
 * render its picker without pulling any voice runtime into the route graph.
 */
export const DEFAULT_KOKORO_VOICE = 'af_heart';

export type KokoroVoice = {
  id: string;
  label: string;
  gender: 'F' | 'M';
  accent: string;
  grade: string;
};

export const KOKORO_VOICES: KokoroVoice[] = [
  // American English — Female
  { id: 'af_heart',   label: 'Heart',   gender: 'F', accent: 'US', grade: 'A' },
  { id: 'af_bella',   label: 'Bella',   gender: 'F', accent: 'US', grade: 'A-' },
  { id: 'af_nicole',  label: 'Nicole',  gender: 'F', accent: 'US', grade: 'B-' },
  { id: 'af_aoede',   label: 'Aoede',   gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_kore',    label: 'Kore',    gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_sarah',   label: 'Sarah',   gender: 'F', accent: 'US', grade: 'C+' },
  { id: 'af_alloy',   label: 'Alloy',   gender: 'F', accent: 'US', grade: 'C' },
  { id: 'af_nova',    label: 'Nova',    gender: 'F', accent: 'US', grade: 'C' },
  { id: 'af_sky',     label: 'Sky',     gender: 'F', accent: 'US', grade: 'C-' },
  { id: 'af_jessica', label: 'Jessica', gender: 'F', accent: 'US', grade: 'D' },
  { id: 'af_river',   label: 'River',   gender: 'F', accent: 'US', grade: 'D' },
  // American English — Male
  { id: 'am_fenrir',  label: 'Fenrir',  gender: 'M', accent: 'US', grade: 'C+' },
  { id: 'am_michael', label: 'Michael', gender: 'M', accent: 'US', grade: 'C+' },
  { id: 'am_puck',    label: 'Puck',    gender: 'M', accent: 'US', grade: 'C+' },
  { id: 'am_adam',    label: 'Adam',    gender: 'M', accent: 'US', grade: 'F+' },
  { id: 'am_echo',    label: 'Echo',    gender: 'M', accent: 'US', grade: 'D' },
  { id: 'am_eric',    label: 'Eric',    gender: 'M', accent: 'US', grade: 'D' },
  { id: 'am_liam',    label: 'Liam',    gender: 'M', accent: 'US', grade: 'D' },
  { id: 'am_onyx',    label: 'Onyx',    gender: 'M', accent: 'US', grade: 'D' },
  // British English — Female
  { id: 'bf_emma',     label: 'Emma',     gender: 'F', accent: 'UK', grade: 'B-' },
  { id: 'bf_isabella', label: 'Isabella', gender: 'F', accent: 'UK', grade: 'C' },
  { id: 'bf_alice',    label: 'Alice',    gender: 'F', accent: 'UK', grade: 'D' },
  { id: 'bf_lily',     label: 'Lily',     gender: 'F', accent: 'UK', grade: 'D' },
  // British English — Male
  { id: 'bm_george',  label: 'George',  gender: 'M', accent: 'UK', grade: 'C' },
  { id: 'bm_fable',   label: 'Fable',   gender: 'M', accent: 'UK', grade: 'C' },
  { id: 'bm_daniel',  label: 'Daniel',  gender: 'M', accent: 'UK', grade: 'D' },
  { id: 'bm_lewis',   label: 'Lewis',   gender: 'M', accent: 'UK', grade: 'D+' },
];
