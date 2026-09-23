/* Kin Studio inference engine (used by Sterward). Runs a language model fully in the browser via Transformers.js — no API key. */
'use strict';
/** Shared inference engine. Direct mode does not create or require a Worker.
 * No eval, no chat API, no canned answers. External downloads start on Load.
 * Pin the bundled build: transformers.web.min.js has bare dependencies in v3.8.1.
 */
function createKinEngine(emit, options = {}) {
  const SOURCES = [
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js',
    'https://unpkg.com/@huggingface/transformers@3.8.1/dist/transformers.min.js'
  ];
  let generator = null, library = null, stopping = null, activeModel = null;
  let generating = false, interrupted = false, alive = true;
  let loadingTask = null, generationTask = null, closingTask = null;
  const notify = (type, payload = {}) => { if (alive) emit({ type, ...payload }); };
  const describe = error => error?.message || String(error);
  const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
  const progress = (status, file) => notify('progress', { detail: { status, file } });
  async function importWithTimeout(url) {
    let timer;
    try {
      return await Promise.race([
        import(url),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime download timed out after 25 seconds.')), 25000); })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function initialize({ model, device, localWeights = null }) {
    let overrideUsed = false;
    let phase = 'RUNTIME_IMPORT';
    try {
      if (typeof WebAssembly !== 'object') {
        phase = 'WASM_UNAVAILABLE';
        throw new Error('This browser context does not expose WebAssembly. Open the saved file in a full browser tab, not an attachment preview.');
      }
      let runtimeBase = '', failures = [];
      for (const source of SOURCES) {
        if (!alive) return;
        const url = source + (options.attempt > 1 ? '?kin_retry=' + encodeURIComponent(options.attempt) : '');
        progress('runtime', 'Downloading the AI runtime from ' + new URL(source).hostname);
        notify('diagnostic', { message: 'Runtime import: ' + url });
        try {
          const imported = await importWithTimeout(url);
          if (!alive) return;
          if (typeof imported.pipeline !== 'function') throw new Error('The downloaded runtime did not expose pipeline().');
          library = imported; runtimeBase = new URL('.', source).href; break;
        } catch (error) {
          failures.push(new URL(source).hostname + ': ' + describe(error));
          notify('diagnostic', { message: failures.at(-1) });
        }
      }
      if (!alive) return;
      if (!library) throw new Error('Neither runtime download source could be imported. No model has run. ' + failures.join(' | '));
      library.env.allowLocalModels = false;
      library.env.useBrowserCache = typeof caches !== 'undefined';
      library.env.useCustomCache = false;
      library.env.customCache = null;
      if (localWeights && localWeights.repo === model.repo) {
        let publicCache = null;
        try { if (typeof caches !== 'undefined') publicCache = await caches.open('transformers-cache'); } catch (_) {}
        const expected = model.repo + '/onnx/' + localWeights.filename;
        const expectedRemote = 'https://huggingface.co/' + model.repo + '/resolve/main/onnx/' + localWeights.filename;
        function isOverrideRequest(request) {
          const key = String(request?.url || request).split('?')[0];
          return key === expected || key === '/models/' + expected || key === expectedRemote;
        }
        library.env.customCache = {
          async match(request) {
            if (isOverrideRequest(request)) {
              overrideUsed = true;
              notify('diagnostic', { message: 'Using local ONNX override: ' + localWeights.filename });
              return new Response(localWeights.blob, { status: 200, headers: {'Content-Type':'application/octet-stream','Content-Length':String(localWeights.blob.size)} });
            }
            try { return await publicCache?.match(request); } catch (_) { return undefined; }
          },
          async put(request, response) {
            // Never persist modified weights under the public model's cache key.
            if (isOverrideRequest(request)) return;
            try { await publicCache?.put(request, response); } catch (_) {}
          }
        };
        library.env.useCustomCache = true;
      }
      const wasm = library.env.backends.onnx.wasm;
      // One CPU thread, no ONNX proxy worker, version-matched runtime assets.
      wasm.numThreads = 1;
      wasm.proxy = false;
      wasm.wasmPaths = runtimeBase;
      wasm.initTimeout = 60000;
      let selected = 'wasm';
      if (model.key !== 'pocket' && device !== 'wasm' && globalThis.navigator?.gpu) {
        try { const adapter = await globalThis.navigator.gpu.requestAdapter(); if (adapter) selected = 'webgpu'; }
        catch (_) { /* CPU stays selected. */ }
      }
      if (!alive) return;
      phase = 'MODEL_LOAD';
      progress('model', 'Downloading ' + model.repo + ' and preparing the local ' + selected + ' runtime');
      const config = { dtype: model.dtype, device: selected,
        progress_callback: detail => notify('progress', { detail }) };
      try { generator = await library.pipeline('text-generation', model.repo, config); }
      catch (error) {
        if (selected !== 'webgpu' || !alive) throw error;
        selected = 'wasm';
        notify('fallback', { text: 'The GPU path failed. Trying this model on the CPU.' });
        generator = await library.pipeline('text-generation', model.repo, { ...config, device: selected });
      }
      if (!alive) return;
      // v3.8.1 generation awaits model.forward for each token. Yield before
      // each forward pass so the page can paint and receive Stop events.
      // An individual CPU pass can still briefly block the page.
      if (options.thread === 'direct' && generator.model?.forward) {
        const forward = generator.model.forward.bind(generator.model);
        generator.model.forward = async (...args) => { await yieldToBrowser(); return forward(...args); };
      }
      if (localWeights && !overrideUsed) throw new Error('The runtime did not request the selected local ONNX file. The override was not applied. Check the matching model and quantization.');
      activeModel = model;
      stopping = new library.InterruptableStoppingCriteria();
      notify('ready', { modelKey: model.key, device: selected, thread: options.thread, weightRevision: overrideUsed ? localWeights.revision : 0 });
    } catch (error) {
      notify('error', { phase: 'load', code: phase, message: describe(error) });
    }
  }
function countTokens(messages) {
  const tokens = generator.tokenizer.apply_chat_template(messages, { tokenize: true, add_generation_prompt: true });
  if (Array.isArray(tokens)) return Array.isArray(tokens[0]) ? tokens[0].length : tokens.length;
  if (tokens?.dims) return tokens.dims[tokens.dims.length - 1];
  throw new Error('The tokenizer returned an unsupported token format.');
}
async function generate({ requestId, messages, baseSystem, maxTokens, temperature, topP = 0.9, repetition = 1.1 }) {
  if (!alive || !generator || generating) { notify('error', { phase: 'generate', requestId, message: 'The model is not ready or is already answering.' }); return; }
  generating = true; interrupted = false; stopping.reset();
  let text = '', tokens = 0;
  const started = performance.now();
  try {
    messages = messages.map(m => ({ role: m.role, content: m.content }));
    const allowance = activeModel.context - maxTokens - 32;
    let dropped = 0, memoryRemoved = false;
    while (countTokens(messages) > allowance && messages.length > 2) {
      messages.splice(1, 1); dropped++;
      if (messages[1]?.role === 'assistant') { messages.splice(1, 1); dropped++; }
    }
    if (countTokens(messages) > allowance && messages[0].content !== baseSystem) {
      messages[0].content = baseSystem; memoryRemoved = true;
    }
    const promptTokens = countTokens(messages);
    if (promptTokens > allowance) throw new Error('This message and your identity instructions are too long for the selected context window. Shorten the message or instructions and try again.');
    notify('context', { requestId, dropped, memoryRemoved, promptTokens });
    const streamer = new library.TextStreamer(generator.tokenizer, {
      skip_prompt: true, skip_special_tokens: true,
      callback_function: chunk => { text += chunk; notify('chunk', { requestId, text: chunk }); },
      token_callback_function: () => { tokens++; }
    });
    const options = { max_new_tokens: maxTokens, do_sample: temperature > 0,
      repetition_penalty: repetition, streamer, stopping_criteria: [stopping] };
    if (temperature > 0) { options.temperature = temperature; options.top_p = topP; }
    const result = await generator(messages, options);
    const generated = result?.[0]?.generated_text;
    if (Array.isArray(generated)) {
      const last = generated.at(-1);
      if (last?.role === 'assistant' && typeof last.content === 'string') text = last.content;
    } else if (typeof generated === 'string' && !text) { text = generated; }
    notify('done', { requestId, text, tokens, elapsed: (performance.now() - started) / 1000,
      interrupted, limited: tokens >= maxTokens, promptTokens });
  } catch (error) { notify('error', { phase: 'generate', requestId, message: error?.message || String(error), partial: text }); }
  finally { generating = false; }
}

  return {
    postMessage(message) {
      if (!alive) return;
      if (message.type === 'init' && !loadingTask) loadingTask = initialize(message);
      else if (message.type === 'generate') generationTask = generate(message);
      else if (message.type === 'stop') { interrupted = true; stopping?.interrupt(); }
    },
    terminate() {
      if (closingTask) return closingTask;
      alive = false; interrupted = true; stopping?.interrupt();
      closingTask = Promise.allSettled([loadingTask, generationTask]).then(async () => {
        try { await generator?.dispose?.(); } catch (_) { /* Best-effort cleanup. */ }
        generator = null; library = null; stopping = null;
      });
      return closingTask;
    }
  };
}
