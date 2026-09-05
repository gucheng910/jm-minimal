import CryptoJS from "crypto-js";

export function md5Hex(value: string): string {
  return CryptoJS.MD5(value).toString();
}

// 原客户端实际用法：将 MD5 的 32 位 hex 字符串按 UTF-8 解析成 AES-256-ECB 密钥
export function aesEcbDecrypt(cipherBase64: string, md5KeyHex: string): string {
  const key = CryptoJS.enc.Utf8.parse(md5KeyHex);
  const bytes = CryptoJS.AES.decrypt(cipherBase64, key, {
    mode: CryptoJS.mode.ECB,
    padding: CryptoJS.pad.Pkcs7
  });
  return bytes.toString(CryptoJS.enc.Utf8);
}
