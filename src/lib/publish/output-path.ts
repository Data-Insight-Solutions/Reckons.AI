/** Safe on disk, inside a ZIP, in a Git tree, and inside a quoted HTML URL. */
export function assertSitePath(value: string): string {
  if (!value || value.split('/').some(part => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)
      || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe site output path');
  }
  return value;
}
