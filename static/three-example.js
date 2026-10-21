/* Runs only inside ThreeExampleViewer's sandbox="allow-scripts" frame (no same-origin access).
 * Keep this separate from the application bundle and its CSP. Upstream examples are never
 * evaluated by the graph renderer, and this bridge grants no storage, navigation or device access.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const url = params.get('example') || '';
  const token = params.get('token') || '';
  if (parent === window || !/^[0-9a-f-]{36}$/.test(token)) return;
  const send = (type, message) => parent.postMessage({ channel: 'reckons-three-example', token, type, message }, '*');
  if (!/^https:\/\/threejs\.org\/examples\/(webgl|webgpu)_[a-z0-9_]+\.html$/.test(url)) { send('error', 'Unsupported example URL.'); return; }

  // Inserted BEFORE any upstream code. Source validation is performed again in the parent:
  // a forged message from another frame or an old load cannot change the viewer state.
  function monitor(token) {
    const send = (type, message) => parent.postMessage({ channel: 'reckons-three-example', token, type, message }, '*');
    let rendered = false;
    const ready = () => { if (!rendered) { rendered = true; send('rendered'); } };
    window.addEventListener('error', event => send('error', event.message || 'An example script or asset failed to load.'), true);
    window.addEventListener('unhandledrejection', () => send('error', 'The example failed while loading or rendering.'));
    document.addEventListener('webglcontextlost', () => send('error', 'The graphics context was lost. Try a lighter example.'), true);
    setInterval(() => send('heartbeat'), 1000);
    send('heartbeat');
    for (const api of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!api) continue;
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const original = api.prototype[name];
        if (!original) continue;
        api.prototype[name] = function (...args) { const result = original.apply(this, args); ready(); return result; };
      }
    }
    if (window.GPUQueue) {
      const submit = GPUQueue.prototype.submit;
      GPUQueue.prototype.submit = function (...args) { const result = submit.apply(this, args); ready(); return result; };
    }
    if (window.GPUAdapter) {
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await request.apply(this, args);
        device.lost.then(() => send('error', 'The WebGPU device was lost.'));
        device.addEventListener('uncapturederror', () => send('error', 'The example encountered a WebGPU error.'));
        return device;
      };
    }
  }
  const waiting = setInterval(() => send('heartbeat'), 1000);
  send('heartbeat');
  async function load() {
    // WebGPU demos may fall back to WebGL2; at least one API must be usable. The actual
    // example remains the compatibility test, including its extensions and model sizes.
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const webgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    if ((!url.includes('/webgpu_') && !webgl) || (!webgl && !navigator.gpu)) throw new Error('This browser cannot provide the graphics API required by this example.');
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`The example could not be fetched (HTTP ${response.status}).`);
    const html = await response.text();
    if (html.length > 1_000_000 || !/<head[\s>]/i.test(html)) throw new Error('The example returned an unsupported document.');
    const bootstrap = `<base href="https://threejs.org/examples/"><script>(${monitor.toString()})(${JSON.stringify(token)})<\/script>`;
    // document.open retains this document's CSP. The iframe's sandbox flags remain in force
    // across document replacement and navigation; upstream cannot acquire the app's origin.
    clearInterval(waiting);
    document.open();
    document.write(html.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`));
    document.close();
  }
  load().catch(error => { clearInterval(waiting); send('error', error.message || 'The example could not be loaded.'); });
})();
