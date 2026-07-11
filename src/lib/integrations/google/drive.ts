/**
 * Google Drive API v3 helpers.
 * Uses the `drive.file` scope — only accesses files created or opened by this app.
 */

import { getToken } from './auth';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export type DriveFile = {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
};

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${getToken()}`, ...init.headers }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive API ${res.status}: ${body}`);
  }
  return res;
}

/** List .ttl files visible to this app in the user's Drive. */
export async function listTurtleFiles(): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: "name contains '.ttl' and trashed = false",
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: '100'
  });
  const res = await driveFetch(`${DRIVE}/files?${params}`);
  const data = await res.json();
  return data.files ?? [];
}

/** Download raw text content of a Drive file by ID. */
export async function downloadFile(fileId: string): Promise<string> {
  const res = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
  return res.text();
}

/**
 * Upload a Turtle file to Drive using multipart upload.
 * Pass `existingFileId` to update an existing file in-place.
 * Returns the Drive file ID.
 */
export async function uploadTurtle(
  filename: string,
  content: string,
  existingFileId?: string
): Promise<string> {
  const metadata = { name: filename, mimeType: 'text/turtle' };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'text/turtle' }));

  const url = existingFileId
    ? `${UPLOAD}/files/${existingFileId}?uploadType=multipart`
    : `${UPLOAD}/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive upload ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.id as string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Find a folder by name (optionally within a parent), or create it. Returns its id. */
export async function ensureFolder(name: string, parentId?: string): Promise<string> {
  const clauses = [
    `mimeType = '${FOLDER_MIME}'`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    'trashed = false',
  ];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const params = new URLSearchParams({ q: clauses.join(' and '), fields: 'files(id,name)', pageSize: '1' });
  const found = await (await driveFetch(`${DRIVE}/files?${params}`)).json();
  if (found.files?.length) return found.files[0].id as string;

  const metadata: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  const res = await driveFetch(`${DRIVE}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  return (await res.json()).id as string;
}

/** List `.ttl` files that are DIRECT children of a folder. */
export async function listFolderTurtles(folderId: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name contains '.ttl' and trashed = false`,
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'name',
    pageSize: '200',
  });
  const data = await (await driveFetch(`${DRIVE}/files?${params}`)).json();
  return data.files ?? [];
}

/** List ALL (non-trashed) files that are direct children of a folder. */
export async function listFolderFiles(folderId: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,modifiedTime,size)',
    pageSize: '400',
  });
  const data = await (await driveFetch(`${DRIVE}/files?${params}`)).json();
  return data.files ?? [];
}

/** Upload arbitrary binary INTO a folder (multipart). Update in place with `existingFileId`. */
export async function uploadBinaryToFolder(
  filename: string,
  bytes: Uint8Array,
  mimeType: string,
  folderId: string,
  existingFileId?: string
): Promise<string> {
  const metadata: Record<string, unknown> = { name: filename, mimeType };
  if (!existingFileId) metadata.parents = [folderId];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: mimeType }));
  const url = existingFileId
    ? `${UPLOAD}/files/${existingFileId}?uploadType=multipart`
    : `${UPLOAD}/files?uploadType=multipart`;
  const res = await fetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()).id as string;
}

/** Download a Drive file's raw bytes. */
export async function downloadFileBytes(fileId: string): Promise<Uint8Array> {
  const res = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Upload a `.ttl` INTO a specific folder. Pass `existingFileId` to update in
 * place (its parent is unchanged). Returns the Drive file id.
 */
export async function uploadTurtleToFolder(
  filename: string,
  content: string,
  folderId: string,
  existingFileId?: string
): Promise<string> {
  const metadata: Record<string, unknown> = { name: filename, mimeType: 'text/turtle' };
  if (!existingFileId) metadata.parents = [folderId];

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([content], { type: 'text/turtle' }));

  const url = existingFileId
    ? `${UPLOAD}/files/${existingFileId}?uploadType=multipart`
    : `${UPLOAD}/files?uploadType=multipart`;
  const res = await fetch(url, {
    method: existingFileId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()).id as string;
}
