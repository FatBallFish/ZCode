/**
 * WebP 容器尺寸解析（纯逻辑，specs/desktop/desktop-pet.md）。
 * Electron nativeImage 不解码 WebP（仅 PNG/JPEG），图集尺寸只能读容器头：
 * VP8X（canvas 24-bit 宽高）/ VP8 lossy（sync 0x9d012a + u14）/ VP8L（14-bit 位流）。
 */

export function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

export function readWebpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isWebp(bytes)) return null;
  // RIFF<size4>WEBP 后接 chunk：fourcc + size(LE u32)
  let offset = 12;
  // VP8X chunk 内有 24-bit LE 的 canvas 宽高（各减一）；优先取 canvas 尺寸。
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const chunkSize =
      bytes[offset + 4]! |
      (bytes[offset + 5]! << 8) |
      (bytes[offset + 6]! << 16) |
      (bytes[offset + 7]! << 24);
    const data = offset + 8;
    if (fourcc === "VP8X") {
      if (data + 10 > bytes.length) return null;
      const width = (bytes[data + 4]! | (bytes[data + 5]! << 8) | (bytes[data + 6]! << 16)) + 1;
      const height = (bytes[data + 7]! | (bytes[data + 8]! << 8) | (bytes[data + 9]! << 16)) + 1;
      return { width, height };
    }
    if (fourcc === "VP8 ") {
      // 无损帧不在这里；lossy keyframe：3 字节 frame tag + 3 字节 sync code，随后 u14 宽/高。
      if (data + 10 > bytes.length) return null;
      if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
        return null;
      }
      const width = (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff;
      const height = (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff;
      return { width, height };
    }
    if (fourcc === "VP8L") {
      if (data + 5 > bytes.length || bytes[data] !== 0x2f) return null;
      // 14-bit LE bitstream：width-1 后紧跟 height-1。
      const bits =
        bytes[data + 1]! |
        (bytes[data + 2]! << 8) |
        (bytes[data + 3]! << 16) |
        (bytes[data + 4]! << 24);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    offset = data + chunkSize + (chunkSize % 2); // RIFF chunk 按 2 字节对齐
  }
  return null;
}
