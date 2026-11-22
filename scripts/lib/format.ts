/** 给人看的数量描述：审核 PR 上不只有机器口径。 */

const KB = 1024;
const MB = KB * 1024;

/** `14088` → `14088 bytes（13.8 KB）`：字节数是最精准的基础值不动，括号里给人类单位 */
export function formatSize(size: number): string {
  if (size < KB) return `${size} bytes`;
  const readable = size < MB ? `${(size / KB).toFixed(1)} KB` : `${(size / MB).toFixed(1)} MB`;
  return `${size} bytes（${readable}）`;
}
