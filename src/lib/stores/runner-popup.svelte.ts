/** Open state of the one runner connect popup (F166.1.3), mounted once in the app layout so it
 *  outlives the control that opened it (that control unmounts the moment the runner connects). */
let open = $state(false);
export const runnerPopup = {
  get open() { return open; },
  set open(v: boolean) { open = v; },
};
export function openRunnerPopup() { open = true; }
