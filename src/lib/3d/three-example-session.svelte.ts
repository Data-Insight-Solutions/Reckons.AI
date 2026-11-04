import { threeExampleUrl, THREE_EXAMPLE_LOAD_MS, THREE_EXAMPLE_HEARTBEAT_MS } from './three-example';

export type ThreeExamplePhase = 'idle' | 'loading' | 'running' | 'stopped' | 'failed';

/**
 * One isolated example run: the node viewer and the graph background share this, so both get
 * exactly the same sandbox, timeout, heartbeat and forged-message handling. Removing the frame
 * (source = '') stops its timers, workers and scene. No example code runs in the graph renderer.
 * Browser and GPU-driver crashes remain beyond this boundary.
 */
export class ThreeExampleSession {
  phase = $state<ThreeExamplePhase>('idle');
  /** The sandbox document URL, or '' when nothing is loaded. Bind an iframe's src to it. */
  source = $state('');
  error = $state('');
  #token = '';
  #started = 0;
  #heartbeat = 0;
  #frame: () => HTMLIFrameElement | undefined;

  constructor(frame: () => HTMLIFrameElement | undefined) {
    this.#frame = frame;
  }

  load(url: string) {
    const canonical = threeExampleUrl(url);
    if (!canonical) { this.stop('Only official WebGL and WebGPU example URLs are supported.'); return; }
    this.#token = crypto.randomUUID();
    this.#started = this.#heartbeat = Date.now();
    this.error = '';
    this.phase = 'loading';
    this.source = `/three-example.html?example=${encodeURIComponent(canonical)}&token=${this.#token}`;
  }

  stop(message = '') {
    this.source = '';
    this.#token = '';
    this.error = message;
    this.phase = message ? 'failed' : 'stopped';
  }

  /** Start listening; returns the cleanup. Call from onMount or an $effect. */
  watch(): () => void {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (!this.source || event.source !== this.#frame()?.contentWindow || !data
        || data.channel !== 'reckons-three-example' || data.token !== this.#token) return;
      if (data.type === 'error') this.stop(typeof data.message === 'string' ? data.message.slice(0, 300) : 'The example failed.');
      if (data.type === 'heartbeat') this.#heartbeat = Date.now();
      // The bridge observes a GPU draw/submit. A frame load event alone never marks it ready.
      if (data.type === 'rendered') { this.phase = 'running'; this.#heartbeat = Date.now(); }
    };
    // Hidden tabs throttle the frame's timers; restart the clocks on return instead of failing it.
    const foreground = () => { if (!document.hidden) { this.#heartbeat = Date.now(); this.#started = Date.now(); } };
    window.addEventListener('message', receive);
    document.addEventListener('visibilitychange', foreground);
    const watchdog = setInterval(() => {
      if (!this.source || document.hidden) return;
      const now = Date.now();
      if (this.phase === 'loading' && now - this.#started > THREE_EXAMPLE_LOAD_MS) this.stop('The example did not render within 45 seconds. It may be incompatible or unable to load its assets.');
      else if (now - this.#heartbeat > THREE_EXAMPLE_HEARTBEAT_MS) this.stop('The example stopped responding. It has been unloaded.');
    }, 1000);
    return () => {
      clearInterval(watchdog);
      window.removeEventListener('message', receive);
      document.removeEventListener('visibilitychange', foreground);
      this.source = '';
    };
  }
}

/** The iframe attributes both surfaces must use. Kept here so neither can loosen them alone. */
export const THREE_EXAMPLE_SANDBOX = 'allow-scripts';
export const THREE_EXAMPLE_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; xr-spatial-tracking 'none'";
