/** `upload` namespace dictionaries for the `/upload` command source. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'upload'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'menu.description': '上传文件作为上下文（≤ {limit}）',
  'notice.tooLarge': '“{name}” 有 {size}，超过 {limit} 上限，未上传。',
  'notice.readFailed': '“{name}” 无法读取，未上传。',
  'notice.failed': '上传失败：{reason}',
  'notice.uploaded': '已上传 {path} —— 已作为 @{path} 加入本条消息。',
} satisfies Record<string, string>

/** The upload namespace key union. */
export type UploadKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'menu.description': 'Upload a file as context (≤ {limit})',
  'notice.tooLarge': '“{name}” is {size}, over the {limit} limit — not uploaded.',
  'notice.readFailed': '“{name}” could not be read — not uploaded.',
  'notice.failed': 'Upload failed: {reason}',
  'notice.uploaded': 'Uploaded {path} — added to this message as @{path}.',
} satisfies Record<UploadKey, string>
