// http_ece (reference RFC 8188 implementation, used only to check our push encryption) ships no types.
declare module "http_ece" {
  import type { ECDH } from "node:crypto";
  export function decrypt(buffer: Buffer, params: { version: string; privateKey: ECDH; authSecret: Buffer }): Buffer;
  const ece: { decrypt: typeof decrypt };
  export default ece;
}
