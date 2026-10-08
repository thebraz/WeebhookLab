import type { Header, ReplayRequest, WebhookEvent } from '../shared/contracts';
import { capturedRequest, destination, editableText, utf8Base64 } from '../shared/replay';

interface HeaderRow { name: string; value: string; enabled: boolean; original?: number }
export interface EditorState { request: ReplayRequest; headers: HeaderRow[]; text: string | null; edit: boolean }

export function initialState(event: WebhookEvent): EditorState {
  const request = capturedRequest(event);
  return requestState(request);
}
export function requestState(request: ReplayRequest): EditorState {
  return { request, headers: request.headers.map(([name, value], original) => ({ name, value, enabled: true, original })), text: editableText(request.body, request.headers), edit: false };
}

export function openReplayEditor(editor: EditorState, edit: boolean): EditorState {
  return { ...editor, edit: editor.edit || edit };
}

export function editorRequest(editor: EditorState, original: ReplayRequest): ReplayRequest {
  const headers: Header[] = editor.headers.filter((row) => row.enabled).map((row) => [row.name, row.value]);
  const modifiedBody = editor.text !== null && editor.text !== editableText(original.body, original.headers);
  const request = editor.edit ? { ...editor.request, headers, body: modifiedBody ? { encoding: 'base64' as const, data: utf8Base64(editor.text!) } : original.body }
    : { ...original, destinationUrl: editor.request.destinationUrl, timeoutMs: editor.request.timeoutMs };
  destination(request.destinationUrl);
  if (modifiedBody && editor.edit) {
    if (editableText(request.body, request.headers) === null) throw new Error('Edited text requires UTF-8 without compression or a binary/multipart content type.');
    const contentType = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
    if (/^(application\/json|[^;]+\+json)(;|$)/i.test(contentType) && editor.text?.trim()) {
      try { JSON.parse(editor.text); } catch { throw new Error('Invalid JSON: check the syntax.'); }
    }
  }
  return request;
}
