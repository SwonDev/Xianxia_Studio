#!/usr/bin/env node
/**
 * Generate the 4 cinematic SFX bundled with the narrative renderer.
 *
 * Output: apps/sidecar-node/src/assets/sfx/{whoosh,impact,shimmer,rumble}.wav
 *  - 48 kHz stereo, 16-bit PCM, normalised to -3 dBFS
 *
 * The SFX are deterministic (synthesised from ffmpeg's lavfi sources) so the
 * generated WAVs are checked into git; this script only needs to be re-run
 * when one of the recipes changes.
 *
 * Usage:
 *   node apps/sidecar-node/scripts/generate-sfx.mjs
 */
import { execa } from 'execa';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'src', 'assets', 'sfx');

const SR = 48000;          // sample rate
const NORM_DB = -3;        // target peak in dBFS

await mkdir(OUT_DIR, { recursive: true });

/**
 * Run ffmpeg with a lavfi filter graph that produces the SFX, then pipe it
 * through `loudnorm`-equivalent peak normalisation (`volume` filter with the
 * `replaygain`-style approach is overkill for a 1 s SFX; we use a two-pass
 * `volumedetect` + `volume` instead so the result is exactly NORM_DB peak).
 */
async function synth(name, lavfiGraph, durationSec) {
  const out = join(OUT_DIR, `${name}.wav`);
  const tmp = join(OUT_DIR, `${name}.tmp.wav`);

  // Pass 1: render the synth graph to a temporary WAV, stereo 48 kHz.
  await execa('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', lavfiGraph,
    '-t', String(durationSec),
    '-ac', '2',
    '-ar', String(SR),
    '-sample_fmt', 's16',
    tmp,
  ]);

  // Pass 2: detect peak with volumedetect.
  const { stderr: detectErr } = await execa('ffmpeg', [
    '-i', tmp,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { reject: false });
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(detectErr);
  const peakDb = m ? parseFloat(m[1]) : 0;
  const gainDb = NORM_DB - peakDb;

  // Pass 3: apply gain and write the final 16-bit PCM WAV.
  await execa('ffmpeg', [
    '-y',
    '-i', tmp,
    '-af', `volume=${gainDb.toFixed(2)}dB`,
    '-ac', '2',
    '-ar', String(SR),
    '-sample_fmt', 's16',
    out,
  ]);

  // Clean tmp.
  await execa('cmd', ['/c', 'del', '/q', tmp]).catch(async () => {
    // POSIX fallback.
    await execa('rm', ['-f', tmp]).catch(() => {});
  });

  const st = await stat(out);
  console.log(`  ${name.padEnd(8)} -> ${out} (${st.size} bytes, peak ${peakDb} dB, gain ${gainDb.toFixed(2)} dB)`);
}

console.log('Generating SFX into', OUT_DIR);

// 1) WHOOSH — 1.0 s swept brown noise, fade in/out, bandpassed wide so it
//    sweeps from ~4 kHz down to ~200 Hz feel. Uses brown noise + bandpass +
//    fades; frequency sweep is implied by `volume` envelope on a
//    high-passed copy mixed with a low-passed copy (cheap pseudo-sweep).
await synth(
  'whoosh',
  // brown noise → split into "high" and "low" → crossfade so perceived
  // pitch sweeps top→bottom. Final bandpass keeps it clean.
  'anoisesrc=color=brown:sample_rate=48000:duration=1.0,'
    + 'asplit=2[hi][lo];'
    + '[hi]highpass=f=2000,volume=\'if(lt(t,0.5),1,2*(1-t))\':eval=frame[h];'
    + '[lo]lowpass=f=600,volume=\'if(lt(t,0.5),2*t,1)\':eval=frame[l];'
    + '[h][l]amix=inputs=2:duration=longest:dropout_transition=0,'
    + 'bandpass=f=1500:width_type=h:width=3500,'
    + 'afade=t=in:st=0:d=0.05,'
    + 'afade=t=out:st=0.7:d=0.3',
  1.0,
);

// 2) IMPACT — 0.4 s. Low 60 Hz kick (sine) + 1 kHz transient (sine) at the
//    very start, both with sharp decays. Combined for a punchy drum-style
//    hit suitable for title-card reveals.
await synth(
  'impact',
  'sine=frequency=60:sample_rate=48000:duration=0.4[low];'
    + 'sine=frequency=1000:sample_rate=48000:duration=0.05[click];'
    + '[low]volume=\'exp(-t*8)\':eval=frame[lowEnv];'
    + '[click]volume=\'exp(-t*60)\':eval=frame[clickEnv];'
    + '[lowEnv][clickEnv]amix=inputs=2:duration=longest:dropout_transition=0,'
    + 'afade=t=out:st=0.35:d=0.05',
  0.4,
);

// 3) SHIMMER — 0.8 s arpeggio of 4 sine partials (1.5, 2.5, 3.5, 5 kHz)
//    staggered every 50 ms with short bell-like decays. Adds a touch of
//    echo for sparkle.
await synth(
  'shimmer',
  // Each partial is a short sine with exponential decay, delayed by N×50 ms.
  // We render each into its own buffer and mix.
  'sine=frequency=1500:sample_rate=48000:duration=0.6,'
    + 'volume=\'exp(-t*6)\':eval=frame,'
    + 'adelay=0|0[s1];'
    + 'sine=frequency=2500:sample_rate=48000:duration=0.6,'
    + 'volume=\'exp(-t*6)\':eval=frame,'
    + 'adelay=50|50[s2];'
    + 'sine=frequency=3500:sample_rate=48000:duration=0.6,'
    + 'volume=\'exp(-t*7)\':eval=frame,'
    + 'adelay=100|100[s3];'
    + 'sine=frequency=5000:sample_rate=48000:duration=0.5,'
    + 'volume=\'exp(-t*9)\':eval=frame,'
    + 'adelay=150|150[s4];'
    + '[s1][s2][s3][s4]amix=inputs=4:duration=longest:dropout_transition=0,'
    + 'aecho=0.6:0.4:60:0.3,'
    + 'afade=t=out:st=0.65:d=0.15',
  0.8,
);

// 4) RUMBLE — 3 s sustained low rumble (brown noise low-passed at 100 Hz)
//    with 0.5 s fade-in / fade-out for use as a bed under dramatic moments.
await synth(
  'rumble',
  'anoisesrc=color=brown:sample_rate=48000:duration=3.0,'
    + 'lowpass=f=100,'
    + 'volume=2.0,'
    + 'afade=t=in:st=0:d=0.5,'
    + 'afade=t=out:st=2.5:d=0.5',
  3.0,
);

console.log('Done.');
