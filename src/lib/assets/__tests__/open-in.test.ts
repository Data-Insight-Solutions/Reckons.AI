import { describe, it, expect } from 'vitest';
import {
  KNOWN_APPS,
  appsFor,
  defaultAppFor,
  openInCommand
} from '../open-in';

describe('open-in resolver', () => {
  it('should find Inkscape for SVG files', () => {
    const apps = appsFor('test.svg');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('inkscape');
  });

  it('should handle uppercase extensions', () => {
    const apps = appsFor('test.SVG');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('inkscape');
  });

  it('should return empty array for files with no extension', () => {
    const apps = appsFor('no-extension-file');
    expect(apps).toHaveLength(0);
  });

  it('should find GIMP for PNG files', () => {
    const apps = appsFor('test.png');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('gimp');
  });

  it('should find GIMP for JPG files', () => {
    const apps = appsFor('test.jpg');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('gimp');
  });

  it('should find GIMP for JPEG files', () => {
    const apps = appsFor('test.jpeg');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('gimp');
  });

  it('should find Blender for GLB files', () => {
    const apps = appsFor('test.glb');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('blender');
  });

  it('should find ArtCraft for MP4 files', () => {
    const apps = appsFor('test.mp4');
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe('artcraft');
  });

  it('should return undefined for unknown extensions', () => {
    const apps = appsFor('test.xyz');
    expect(apps).toHaveLength(0);
  });

  it('should respect user defaults when the app handles the type', () => {
    const defaults = { svg: 'gimp' }; // User prefers GIMP for SVG
    const app = defaultAppFor('test.svg', defaults);
    expect(app?.id).toBe('gimp');
  });

  it('should fall back to first available app when user default is not available', () => {
    const defaults = { svg: 'nonexistent-app' }; // User prefers an app that doesn't handle SVG
    const app = defaultAppFor('test.svg', defaults);
    expect(app?.id).toBe('inkscape'); // Should fall back to the first available app
  });

  it('should return undefined when no apps can handle the file type', () => {
    const defaults = { xyz: 'gimp' };
    const app = defaultAppFor('test.xyz', defaults);
    expect(app).toBeUndefined();
  });

  it('should return the first app when no defaults are provided', () => {
    const app = defaultAppFor('test.svg', {});
    expect(app?.id).toBe('inkscape');
  });

  it('should handle paths with spaces and quotes correctly in command generation', () => {
    const app = KNOWN_APPS.find(a => a.id === 'inkscape')!;
    const command = openInCommand(app, '/path/with spaces/and "quotes".svg');
    expect(command.command).toBe('inkscape');
    expect(command.args).toEqual(['/path/with spaces/and "quotes".svg']);
  });

  it('should return undefined for files with no extension when checking defaults', () => {
    const app = defaultAppFor('no-extension-file', { svg: 'gimp' });
    expect(app).toBeUndefined();
  });
});