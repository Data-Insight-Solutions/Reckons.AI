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
