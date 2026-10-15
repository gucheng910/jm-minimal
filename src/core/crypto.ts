/**
 * 加密原语：**按需引入 crypto-js 子模块**。
 *
 * 原来这里写的是 `import CryptoJS from "crypto-js"` —— 伞形入口会 `require` 33 个子模块
 * （AES / DES / TripleDES / Rabbit / RC4 / Blowfish / MD5 / SHA1 / SHA256 / SHA512 / PBKDF2 / EvpKDF …），
 * 而本文件只用到 **MD5 + AES-ECB + Utf8**。crypto-js 是 CJS，tree-shaking 对它无效，
 * 只能靠"少 require"来减体积 —— 否则整套库都进首包，而这两条调用都在**启动路径**上
 * （core/host 的气泡解密、core/api 的正文解密）。
 *
 * 实测（同链路 terser 对比）：全量 63,100 B → 本文件这一组 16,637 B，**省 46 KB（gzip 省 17 KB）**。
 * 已知向量由 crypto.test.ts 钉住（改引入方式若破坏了 ECB/Pkcs7 的注册，那条测试会红）。
 */
import MD5 from "crypto-js/md5";
import AES from "crypto-js/aes";
import Utf8 from "crypto-js/enc-utf8";
import ECB from "crypto-js/mode-ecb";
import Pkcs7 from "crypto-js/pad-pkcs7";

export function md5Hex(value: string): string {
  return MD5(value).toString();
}

// 原客户端实际用法：将 MD5 的 32 位 hex 字符串按 UTF-8 解析成 AES-256-ECB 密钥
export function aesEcbDecrypt(cipherBase64: string, md5KeyHex: string): string {
  const key = Utf8.parse(md5KeyHex);
  const bytes = AES.decrypt(cipherBase64, key, { mode: ECB, padding: Pkcs7 });
  return bytes.toString(Utf8);
}
