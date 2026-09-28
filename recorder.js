/* Steward meeting recorder: records audio in the browser, transcribes it on this device with Whisper
 * (Transformers.js in a worker, nothing uploaded), then Steward writes the summary and pulls out actions.
 * Only the transcript text is sent to the AI for the summary (your Space, or Private mode on-device). */
const WHISPER_MODEL = 'onnx-community/whisper-base';
const WHISPER_WORKER = `
let asr = null;
async function load(model) {
  const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
  const gpu = !!(self.navigator && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null));
  const seen = {};
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) { seen[p.file] = [p.loaded, p.total]; const v = Object.values(seen); postMessage({ type: 'load', pct: Math.round(v.reduce((a, x) => a + x[0], 0) / v.reduce((a, x) => a + x[1], 0) * 100) }); }
  };
  asr = await pipeline('automatic-speech-recognition', model, gpu
    ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
    : { device: 'wasm', dtype: 'q8', progress_callback });
  return gpu ? 'webgpu' : 'wasm';
}
onmessage = async (e) => {
  const { audio, model } = e.data;
  try {
    const device = asr ? null : await load(model);
    postMessage({ type: 'ready', device });
    const SR = 16000, STEP = 30 * SR, out = [];
    for (let i = 0; i < audio.length; i += STEP) {
      const part = audio.subarray(i, Math.min(audio.length, i + STEP));
      if (part.length < SR / 2) break;
      const r = await asr(part, { language: 'english', task: 'transcribe' });
      const text = String(r.text || '').trim();
      if (text && !/^\\[?(blank_audio|music|silence)\\]?$/i.test(text)) out.push(text);
      postMessage({ type: 'part', done: Math.min(audio.length, i + STEP) / SR, total: audio.length / SR, text: out.join(' ') });
    }
    postMessage({ type: 'done', text: out.join(' ') });
  } catch (err) { postMessage({ type: 'error', message: err && err.message || String(err) }); }
};`;

/* Records the microphone, optionally mixed with a shared tab's audio (online meetings in the browser). */
async function startRecording({ tabAudio }) {
  const streams = [];
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  streams.push(mic);
  if (tabAudio) {
    const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (!disp.getAudioTracks().length) { disp.getTracks().forEach((t) => t.stop()); mic.getTracks().forEach((t) => t.stop()); throw new Error('No tab audio was shared. When choosing the tab, tick “Share tab audio”.'); }
    streams.push(disp);
  }
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const meter = ctx.createAnalyser(); meter.fftSize = 512;
  for (const s of streams) { if (s.getAudioTracks().length) { const src = ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())); src.connect(dest); src.connect(meter); } }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(dest.stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  rec.start(1000);
  let lock = null; try { lock = await navigator.wakeLock.request('screen'); } catch (e) {}
  const buf = new Uint8Array(meter.frequencyBinCount);
  const stopAll = () => { streams.forEach((s) => s.getTracks().forEach((t) => t.stop())); ctx.close().catch(() => {}); if (lock) lock.release().catch(() => {}); };
  // Sharing a tab can be stopped from the browser's own bar; keep recording the mic if so.
  return {
    level() { meter.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); return m / 128; },
    pause() { if (rec.state === 'recording') rec.pause(); },
    resume() { if (rec.state === 'paused') rec.resume(); },
    get state() { return rec.state; },
    stop() { return new Promise((resolve) => { rec.onstop = () => { stopAll(); resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); }; rec.stop(); }); },
    cancel() { try { rec.stop(); } catch (e) {} stopAll(); },
  };
}

/* Any recording or audio/video file → 16 kHz mono samples for Whisper. */
async function audioSamples(blob) {
  const data = await blob.arrayBuffer();
  const ctx = new AudioContext();
  let decoded;
  try { decoded = await ctx.decodeAudioData(data); }
  catch (e) { throw new Error('This browser can’t read that file’s audio. Try an .mp3, .m4a, .wav or .webm file.'); }
  finally { ctx.close().catch(() => {}); }
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}

let whisperWorker = null;
/* Transcribes on this device. onProgress gets { stage: 'load'|'transcribe', pct, done, total, text }. */
async function transcribeAudio(blob, onProgress) {
  const audio = await audioSamples(blob);
  if (audio.length < 16000) throw new Error('The recording is too short to transcribe.');
  if (!whisperWorker) whisperWorker = new Worker(URL.createObjectURL(new Blob([WHISPER_WORKER], { type: 'text/javascript' })), { type: 'module' });
  return new Promise((resolve, reject) => {
    whisperWorker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'load') onProgress({ stage: 'load', pct: d.pct });
      if (d.type === 'ready') onProgress({ stage: 'transcribe', done: 0, total: audio.length / 16000, text: '' });
      if (d.type === 'part') onProgress({ stage: 'transcribe', done: d.done, total: d.total, text: d.text });
      if (d.type === 'done') resolve(d.text);
      if (d.type === 'error') { whisperWorker.terminate(); whisperWorker = null; reject(new Error(d.message)); }
    };
    whisperWorker.onerror = (e) => { whisperWorker = null; reject(new Error(e.message || 'The speech model failed to start.')); };
    whisperWorker.postMessage({ audio, model: WHISPER_MODEL }, [audio.buffer]);
  });
}

/* Summary, decisions, action items and follow-ups from a transcript. Long meetings are summarized in parts first. */
async function summarizeMeeting(transcript, state, onChunk) {
  await kinReady();
  const cloud = kinAI.device === 'cloud';
  const size = cloud ? 16000 : 5000;
  const sys = 'You write clear, faithful meeting notes from a raw speech-to-text transcript. The transcript has no speaker names and may contain recognition mistakes; fix obvious ones silently and never invent facts, names, dates or decisions.';
  const facts = kinRecall(transcript.slice(0, 2000), 8).map((m) => '- ' + m.text).join('\n');
  let material = transcript;
  if (transcript.length > size) {
    const parts = [];
    for (let i = 0; i < transcript.length; i += size) {
      const out = await kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Part ' + (parts.length + 1) + ' of a meeting transcript. List the key points, decisions, action items (with who and when if said) and open questions as short bullets.\n\n' + transcript.slice(i, i + size) }], baseSystem: sys, maxTokens: 450, temperature: 0.2, docs: false });
      parts.push(out);
    }
    material = parts.map((p, i) => 'Notes from part ' + (i + 1) + ':\n' + p).join('\n\n');
  }
  const user = 'Today is ' + fmtD(Date.now()) + '.\n' + (facts ? 'About the user (the person who recorded this):\n' + facts + '\n' : '')
    + 'Write the meeting notes in exactly this format:\n## Summary\n2–4 sentences.\n## Decisions\n- ...\n## Action items\n- [ ] Short task starting with a verb, with a duration like 30m and a day like "by fri" when known\n## Open questions\n- ...\nLeave a section with "- None" if empty.\n\n'
    + (material === transcript ? 'Transcript:\n' : '') + material;
  return kinAI.ask({ messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], baseSystem: sys, maxTokens: 700, temperature: 0.2, docs: false, onChunk });
}
