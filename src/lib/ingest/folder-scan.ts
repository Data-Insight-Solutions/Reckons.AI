/**
 * Folder ingest — recursively scan a directory via File System Access API.
 * Extracts structure (paths, names, extensions, sizes) as RDF and reads
 * text-based files for content extraction when possible.
 */

import type { Statement } from '$lib/rdf/types';
import { v4 as uuid } from 'uuid';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const P = 'urn:kbase:predicate/';

function iri(value: string) {
  return { kind: 'iri' as const, value };
}
function lit(value: string) {
  return {
    kind: 'literal' as const,
    value,
    datatype: 'http://www.w3.org/2001/XMLSchema#string' as string | null,
    lang: null as string | null
  };
}

export interface ScannedFile {
  path: string;
  name: string;
  extension: string;
  size: number;
  isReadable: boolean;
  content?: string;
  handle: FileSystemFileHandle;
}

export interface FolderScanResult {
  rootName: string;
  files: ScannedFile[];
  directories: string[];
  totalSize: number;
}

// File extensions we can read as text
const TEXT_EXTENSIONS = new Set([
  // Documents
  'txt', 'md', 'markdown', 'rst', 'org', 'adoc', 'tex', 'rtf',
  // Code
  'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'swift', 'kt', 'scala', 'clj', 'ex', 'exs', 'lua', 'r', 'jl', 'zig',
  'svelte', 'vue', 'astro', 'html', 'htm', 'css', 'scss', 'less', 'sass',
  // Config
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'svg', 'graphql', 'gql', 'proto',
  // Data
  'csv', 'tsv', 'sql', 'ttl', 'n3', 'nq', 'nt', 'rdf', 'jsonld',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  // Other
  'log', 'gitignore', 'dockerignore', 'editorconfig', 'makefile',
]);

// Max file size to attempt reading (5MB)
const MAX_READ_SIZE = 5 * 1024 * 1024;

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svelte-kit', '__pycache__', '.venv',
  'venv', 'dist', 'build', '.next', '.nuxt', 'target', '.cargo'
]);

export function isReadableExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Recursively scan a directory handle.
 */
export async function scanFolder(
  dirHandle: FileSystemDirectoryHandle,
  onProgress?: (msg: string) => void
): Promise<FolderScanResult> {
  const files: ScannedFile[] = [];
  const directories: string[] = [];
  let totalSize = 0;

  async function walk(handle: FileSystemDirectoryHandle, prefix: string) {
    for await (const entry of (handle as any).values()) {
      if (entry.kind === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue;
        const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        directories.push(dirPath);
        onProgress?.(`Scanning ${dirPath}/...`);
        await walk(entry, dirPath);
      } else {
        const filePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const ext = entry.name.includes('.') ? entry.name.split('.').pop()!.toLowerCase() : '';
        const fileHandle = entry as FileSystemFileHandle;

        let size = 0;
        let content: string | undefined;
        let isReadable = isReadableExtension(ext);

        try {
          const file = await fileHandle.getFile();
          size = file.size;
          totalSize += size;

          if (isReadable && size <= MAX_READ_SIZE) {
            content = await file.text();
          } else if (size > MAX_READ_SIZE) {
            isReadable = false;
          }
        } catch {
          isReadable = false;
        }

        files.push({ path: filePath, name: entry.name, extension: ext, size, isReadable, content, handle: fileHandle });
      }
    }
  }

  onProgress?.(`Scanning ${dirHandle.name}/...`);
  await walk(dirHandle, '');

  return { rootName: dirHandle.name, files, directories, totalSize };
}

/**
 * Convert folder scan results into RDF statements.
 * Creates:
 * - A root folder node
 * - Directory nodes with parent-child relationships
 * - File nodes with name, extension, size, path, and content (if readable)
 */
export function folderToStatements(
  scan: FolderScanResult,
  sourceId: string
): Statement[] {
  const now = Date.now();
  const stmts: Statement[] = [];
  const g = iri(`urn:kbase:source/${sourceId}`);
  const rootIri = iri(`urn:kbase:folder/${encodeURIComponent(scan.rootName)}`);

  function add(s: ReturnType<typeof iri>, predicate: string, o: ReturnType<typeof iri> | ReturnType<typeof lit>) {
    stmts.push({
      id: uuid(), s: s as any, p: iri(predicate) as any, o: o as any, g: g as any, sourceId,
      confidence: 1.0, status: 'pending', createdAt: now, updatedAt: now
    });
  }

  // Root folder
  add(rootIri, RDFS_LABEL, lit(scan.rootName));
  add(rootIri, `${P}type`, iri('urn:kbase:type/Folder'));
  add(rootIri, `${P}file-count`, lit(String(scan.files.length)));
  add(rootIri, `${P}total-size`, lit(formatBytes(scan.totalSize)));

  // Directories
  for (const dir of scan.directories) {
    const dirIri = iri(`urn:kbase:folder/${encodeURIComponent(scan.rootName)}/${encodeURIComponent(dir)}`);
    const dirName = dir.split('/').pop()!;
    add(dirIri, RDFS_LABEL, lit(dirName));
    add(dirIri, `${P}type`, iri('urn:kbase:type/Folder'));
    add(dirIri, `${P}path`, lit(dir));

    // Parent relationship
    const parentPath = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const parentIri = parentPath
      ? iri(`urn:kbase:folder/${encodeURIComponent(scan.rootName)}/${encodeURIComponent(parentPath)}`)
      : rootIri;
    add(dirIri, `${P}parent`, parentIri);
  }

  // Files
  for (const file of scan.files) {
    const fileIri = iri(`urn:kbase:file/${encodeURIComponent(scan.rootName)}/${encodeURIComponent(file.path)}`);
    add(fileIri, RDFS_LABEL, lit(file.name));
    add(fileIri, `${P}type`, iri('urn:kbase:type/File'));
    add(fileIri, `${P}path`, lit(file.path));
    add(fileIri, `${P}extension`, lit(file.extension || '(none)'));
    add(fileIri, `${P}file-size`, lit(formatBytes(file.size)));

    // Parent directory
    const parentDir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const parentIri = parentDir
      ? iri(`urn:kbase:folder/${encodeURIComponent(scan.rootName)}/${encodeURIComponent(parentDir)}`)
      : rootIri;
    add(fileIri, `${P}parent`, parentIri);

    // File name can reveal content — extract keywords from it
    const nameWithoutExt = file.name.replace(/\.[^.]+$/, '');
    const keywords = extractKeywordsFromName(nameWithoutExt);
    for (const kw of keywords) {
      add(fileIri, `${P}tagged`, iri(`urn:kbase:concept/${encodeURIComponent(kw.toLowerCase())}`));
    }

    // Content summary (first 500 chars as description if readable)
    if (file.content) {
      const summary = file.content.slice(0, 500).trim();
      if (summary) {
        add(fileIri, `${P}description`, lit(summary));
      }
    }
  }

  return stmts;
}

/**
 * Extract meaningful keywords from a file name.
 * Splits on separators (-, _, camelCase, spaces) and filters short/common words.
 */
function extractKeywordsFromName(name: string): string[] {
  // Split on common separators and camelCase
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
    .replace(/[_\-.\s]+/g, ' ')             // separators
    .split(' ')
    .filter(w => w.length > 2);

  // Remove common non-informative words
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'new', 'old', 'tmp', 'temp']);
  return parts.filter(w => !stopWords.has(w.toLowerCase()));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
