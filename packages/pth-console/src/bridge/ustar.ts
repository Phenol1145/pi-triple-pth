/**
 * bridge/ustar.ts — 纯 Node ustar 写入器
 *
 * USTAR 格式（IEEE Std 1003.1-1988）：
 * 每条记录 512 字节（header），文件内容按 512 整数倍填充。
 * 末尾 2 条全零记录标记 EOF。
 *
 * 确定性保证：
 * - 文件列表按路径字节序（Buffer.compare）排序
 * - uid/gid = 0, uname/gname = "root", mode = 0o644, mtime = 0
 * - 路径字节 > 100 抛错（不做 PAX 扩展）
 * - 第 148 字节校验和：header 中该字段 8 字节视为空格计算
 *
 * 参考：https://www.gnu.org/software/tar/manual/html_node/Standard.html
 */

interface UstarEntry {
  path: string;
  content: Buffer;
}

/** 将数字转为八进制 ASCII 字符串并左填充 0 到 width 字节 */
function octal(n: number, width: number): string {
  const s = n.toString(8);
  if (s.length > width) {
    throw new Error(`值 ${n} 超过 ${width} 位八进制上限`);
  }
  return s.padStart(width - 1, "0") + "\0";
}

/** 将字符串截断/填充到 width 字节 */
function strToBuf(s: string, width: number, prefix: number = 0): Buffer {
  const buf = Buffer.alloc(width);
  const max = Math.min(width, Buffer.byteLength(s));
  buf.fill(0);
  buf.write(s.slice(0, max), 0, max, "utf-8");
  // 为 prefix 字段留 null
  return buf;
}

/**
 * 写一份确定性 ustar 归档。
 * @param entries 文件和目录（按路径排序后的列表）
 * @returns 归档 Buffer（不包含压缩）
 */
export function writeUstar(files: { path: string; content: Buffer | string }[]): Buffer {
  const entries: UstarEntry[] = files
    .map((f) => ({
      path: f.path,
      content: typeof f.content === "string" ? Buffer.from(f.content, "utf-8") : f.content,
    }))
    .sort((a, b) => {
      // 字节序排序（确定性）
      const bufA = Buffer.from(a.path);
      const bufB = Buffer.from(b.path);
      return Buffer.compare(bufA, bufB);
    });

  // 收集目录隐式条目
  const dirSet = new Set<string>();
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }

  // 收集 blocks
  const blocks: Buffer[] = [];

  function pushDir(dirPath: string) {
    const header = Buffer.alloc(512);
    const normalizedPath = dirPath.endsWith("/") ? dirPath : dirPath + "/";

    if (Buffer.byteLength(normalizedPath) > 100) {
      throw new Error(`目录路径超过 100 字节: ${normalizedPath}`);
    }

    // name (100 bytes)
    header.write(normalizedPath.slice(0, 100), 0, 100, "utf-8");
    // mode (8 bytes) — 0o755 for dirs
    header.write(octal(0o755, 8), 100, 8, "utf-8");
    // uid (8) — 0
    header.write(octal(0, 8), 108, 8, "utf-8");
    // gid (8) — 0
    header.write(octal(0, 8), 116, 8, "utf-8");
    // size (12) — 0 for dirs
    header.write(octal(0, 12), 124, 12, "utf-8");
    // mtime (12) — 0
    header.write(octal(0, 12), 136, 12, "utf-8");
    // typeflag (1) — '5' = dir
    header.write("5", 156, 1, "utf-8");
    // uname (32) — ""
    header.fill(0, 265, 265 + 32);
    // gname (32) — ""
    header.fill(0, 297, 297 + 32);
    // magic + version
    header.write("ustar\0", 257, 6, "utf-8");
    header.write("00", 263, 2, "utf-8");
    // prefix (155) — ""
    header.fill(0, 345, 345 + 155);

    // 校验和
    checksum(header);
    blocks.push(header);
  }

  // 先写目录
  for (const d of [...dirSet].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    pushDir(d);
  }

  // 再写文件
  for (const entry of entries) {
    if (Buffer.byteLength(entry.path) > 100) {
      throw new Error(`文件路径超过 100 字节: ${entry.path}`);
    }

    const header = Buffer.alloc(512);

    // name (100 bytes)
    header.write(entry.path.slice(0, 100), 0, 100, "utf-8");
    // mode (8) — 0o644
    header.write(octal(0o644, 8), 100, 8, "utf-8");
    // uid (8) — 0
    header.write(octal(0, 8), 108, 8, "utf-8");
    // gid (8) — 0
    header.write(octal(0, 8), 116, 8, "utf-8");
    // size (12)
    header.write(octal(entry.content.length, 12), 124, 12, "utf-8");
    // mtime (12) — 0
    header.write(octal(0, 12), 136, 12, "utf-8");
    // typeflag (1) — '0' = regular file
    header.write("0", 156, 1, "utf-8");
    // uname (32)
    header.fill(0, 265, 265 + 32);
    // gname (32)
    header.fill(0, 297, 297 + 32);
    // magic + version
    header.write("ustar\0", 257, 6, "utf-8");
    header.write("00", 263, 2, "utf-8");
    // prefix (155)
    header.fill(0, 345, 345 + 155);

    checksum(header);
    blocks.push(header);

    // file content padding to 512
    if (entry.content.length > 0) {
      const pad = 512 - (entry.content.length % 512);
      if (pad < 512) {
        const padded = Buffer.alloc(entry.content.length + pad);
        entry.content.copy(padded);
        padded.fill(0, entry.content.length);
        blocks.push(padded);
      } else {
        blocks.push(entry.content);
      }
    }
  }

  // 2 条零块 EOF
  blocks.push(Buffer.alloc(512));
  blocks.push(Buffer.alloc(512));

  return Buffer.concat(blocks);
}

function checksum(header: Buffer) {
  // 设置校验和字段为空格
  header.write("        ", 148, 8, "utf-8");
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    sum += header[i]!;
  }
  header.write(octal(sum, 7) + "\0", 148, 8, "utf-8");
}
