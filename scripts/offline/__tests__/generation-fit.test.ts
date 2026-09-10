import { describe, it, expect } from 'vitest';
import { scoreOpen, scoreInstall, scoreInvoke, catalogueRepos } from '../generation-fit';

describe('scoreOpen — licence class', () => {
  it('scores permissive licences fully', () => {
    for (const l of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'MPL-2.0']) {
      expect(scoreOpen(l).score, l).toBe(2);
    }
  });

  it('scores copyleft as usable-at-arms-length, and says so', () => {
    const gpl = scoreOpen('GPL-3.0');
    expect(gpl.score).toBe(1);
    expect(gpl.why).toContain('sidecar only');
  });

  // Not a matter of degree: this is what refused LivePortrait, MuseTalk and the Hunyuan family.
  it('scores an unrecognised licence at zero', () => {
    for (const l of ['NONE', 'NOASSERTION', 'whatever']) {
      expect(scoreOpen(l).score, l).toBe(0);
      expect(scoreOpen(l).why).toContain('no recognised licence');
    }
  });
});

describe('scoreInstall — from the repository, not from memory', () => {
  it('a prebuilt release beats everything', () => {
    expect(scoreInstall(['setup.py'], true)).toEqual({ score: 2, why: 'prebuilt release' });
  });

  it('docker counts as one command', () => {
    expect(scoreInstall(['Dockerfile'], false).score).toBe(2);
    expect(scoreInstall(['docker-compose.yml'], false).score).toBe(2);
  });

  it('a python environment is a step down, not a failure', () => {
    expect(scoreInstall(['pyproject.toml'], false)).toEqual({ score: 1, why: 'python env' });
    expect(scoreInstall(['requirements.txt'], false).score).toBe(1);
  });

  it('a build from source is also a step down', () => {
    expect(scoreInstall(['CMakeLists.txt'], false)).toEqual({ score: 1, why: 'build from source' });
  });

  it('says unclear rather than guessing', () => {
    expect(scoreInstall(['README.md'], false)).toEqual({ score: 0, why: 'unclear' });
  });

  it('is case-insensitive about filenames', () => {
    expect(scoreInstall(['dockerfile'], false).score).toBe(2);
  });
});

describe('scoreInvoke — documentation evidence, not capability', () => {
  it('reads a shell invocation as a command', () => {
    expect(scoreInvoke('Run it:\n\n```\n./sd --model x.gguf\n```').score).toBe(2);
  });

  it('reads a python module invocation', () => {
    expect(scoreInvoke('python -m mytool --input a.png').score).toBe(2);
  });

  it('reads docker-only as weaker than a CLI', () => {
    const docker = scoreInvoke('docker run myimage');
    expect(docker.score).toBe(1);
    expect(docker.why).toBe('docker only');
  });

  it('reads a local HTTP endpoint', () => {
    expect(scoreInvoke('POST to http://localhost:8188/prompt').score).toBe(1);
  });

  /*
   * THE HONEST LIMIT, ASSERTED SO IT CANNOT BE FORGOTTEN. A zero means the README shows no
   * command — verified against rhasspy/piper, whose README links out to docs instead. It is a real
   * signal about how hard a tool is to drive and NOT proof that no CLI exists, and the score must
   * never be read as the latter.
   */
  it('scores a README with no command at zero, which means undocumented and not incapable', () => {
    const marketing = scoreInvoke('# MyTool\n\nA beautiful tool. See the docs website.');
    expect(marketing.score).toBe(0);
    expect(marketing.why).toBe('no documented command');
  });
});

describe('catalogueRepos', () => {
  it('reads every repo out of the shipped catalogue', () => {
    const repos = catalogueRepos();
    expect(repos.length).toBeGreaterThanOrEqual(20);
    expect(repos).toContain('leejet/stable-diffusion.cpp');
    // owner/name only — a trailing slash or full URL would break every API call downstream.
    for (const r of repos) expect(r).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });
});
