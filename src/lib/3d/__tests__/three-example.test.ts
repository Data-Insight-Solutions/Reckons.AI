import { describe, it, expect } from 'vitest';
import { threeExampleUrl, threeExampleMapFrom, THREE_EXAMPLE_PREDICATE } from '../three-example';
import type { Statement } from '$lib/rdf/types';

describe('official Three.js example attachments', () => {
  it('canonicalizes gallery links and direct examples without accepting executable input', () => {
    expect(threeExampleUrl('https://threejs.org/examples/#webgl_animation_keyframes')).toBe('https://threejs.org/examples/webgl_animation_keyframes.html');
    expect(threeExampleUrl('https://threejs.org/examples/webgpu_compute_particles.html')).toBe('https://threejs.org/examples/webgpu_compute_particles.html');
    for (const input of [
      'javascript:alert(1)', 'https://threejs.org.evil.test/examples/webgl_test.html',
      'https://user:secret@threejs.org/examples/webgl_test.html', 'http://threejs.org/examples/webgl_test.html',
      'https://threejs.org:444/examples/webgl_test.html', 'https://threejs.org/examples/#webxr_vr_ballshooter',
      'https://threejs.org/examples/#webgl_test?unsafe=1', 'https://threejs.org/examples/webgl_test.html?custom=1',
      'https://threejs.org/examples/webgl_test.html#custom', 'https://threejs.org/examples/#../webgl_test',
      'https://threejs.org/examples/#webgl_%3Cscript%3E', 'https://threejs.org/examples/',
    ]) expect(threeExampleUrl(input), input).toBeNull();
  });
  it('ignores retired attachments and invalid imported values', () => {
    const row = (value: string, status: Statement['status'] = 'confirmed'): Statement => ({
      id: crypto.randomUUID(), s: {kind:'iri',value:'urn:example:node'}, p:{kind:'iri',value:THREE_EXAMPLE_PREDICATE},
      o:{kind:'literal',value}, g:{kind:'iri',value:'urn:example:source'}, sourceId:'example', confidence:1, status, createdAt:0,updatedAt:0,
    });
    expect(threeExampleMapFrom([
      row('https://threejs.org/examples/#webgl_old', 'rejected'),
      row('https://threejs.org/examples/#webgl_old', 'superseded'),
      row('https://threejs.org/examples/#webgl_old', 'pending-removal'),
      row('https://other.test/example.js'), row('https://threejs.org/examples/#webgl_valid'),
    ]).get('urn:example:node')).toBe('https://threejs.org/examples/webgl_valid.html');
  });
});
