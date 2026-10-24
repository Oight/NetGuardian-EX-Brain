/** Browser-only encrypted transport. The server public keys are pinned by the same-origin
 * bootstrap script; loopback origin isolation remains required. This does not replace HTTPS
 * for remote deployment, and never exposes account private keys to the browser. */
import type { PublicIdentity } from '../main/cryptography.js';
const encode = (value: Uint8Array) => btoa(Array.from(value, n => String.fromCharCode(n)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);
function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
}
const id = async (publicKey: string) => encode(new Uint8Array(await crypto.subtle.digest('SHA-256', decode(publicKey))));
export async function createWebChannel(server: PublicIdentity, marker: string) {
    const signing = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
    const agreement = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
    const publicKeys: PublicIdentity = { signing: encode(new Uint8Array(await crypto.subtle.exportKey('spki', signing.publicKey))), agreement: encode(new Uint8Array(await crypto.subtle.exportKey('spki', agreement.publicKey))) };
    const serverAgreement = await crypto.subtle.importKey('spki', decode(server.agreement), { name: 'X25519' }, false, []);
    const serverSigning = await crypto.subtle.importKey('spki', decode(server.signing), { name: 'Ed25519' }, false, ['verify']);
    async function aes(shared: ArrayBuffer, salt: Uint8Array, header: unknown) {
        const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey({
            name: 'HKDF', hash: 'SHA-256', salt: Uint8Array.from(salt), info: utf8(canonical(header))
        }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    return async (path: string, value: unknown) => {
        const nonce = crypto.randomUUID();
        const packet = JSON.parse(JSON.stringify({
            sentAt: Date.now(), nonce, value
        }));
        const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
        const header = {
            version: 1, suite: 'Ed25519+X25519+HKDF-SHA256+AES-256-GCM', context: 'web-request:' + path, recipient: await id(server.agreement), sender: await id(publicKeys.signing), ephemeral: encode(new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey))), salt: encode(crypto.getRandomValues(new Uint8Array(32))), nonce: encode(crypto.getRandomValues(new Uint8Array(12)))
        };
        const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: serverAgreement }, ephemeral.privateKey, 256);
        const key = await aes(shared, decode(header.salt), header);
        new Uint8Array(shared).fill(0);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({
            name: 'AES-GCM', iv: decode(header.nonce), additionalData: utf8(canonical(header)), tagLength: 128
        }, key, utf8(canonical(packet))));
        const unsigned = {
            ...header, ciphertext: encode(encrypted.slice(0, -16)), tag: encode(encrypted.slice(-16))
        };
        const signature = encode(new Uint8Array(await crypto.subtle.sign('Ed25519', signing.privateKey, utf8(canonical(unsigned)))));
        const response = await fetch(path, {
            method: 'POST', headers: { 'content-type': 'application/json', 'X-Campus-Web': marker }, body: JSON.stringify({ publicKeys, envelope: canonical({ ...unsigned, signature }) })
        });
        if (!response.ok)
            throw Error('安全网页通道不可用，请刷新后重试');
        const envelope = await response.json() as Record<string, string | number>;
        const { signature: replySignature, ciphertext, tag, ...replyHeader } = envelope;
        if (replyHeader.version !== 1 || replyHeader.suite !== header.suite || replyHeader.context !== 'web-response:' + path || replyHeader.sender !== await id(server.signing) || replyHeader.recipient !== await id(publicKeys.agreement) || decode(String(replyHeader.nonce)).length !== 12 || decode(String(tag)).length !== 16)
            throw Error('网页响应加密上下文无效');
        if (!await crypto.subtle.verify('Ed25519', serverSigning, decode(String(replySignature)), utf8(canonical({
            ...replyHeader, ciphertext, tag
        }))))
            throw Error('网页响应签名无效');
        const remote = await crypto.subtle.importKey('spki', decode(String(replyHeader.ephemeral)), { name: 'X25519' }, false, []);
        const secret = await crypto.subtle.deriveBits({ name: 'X25519', public: remote }, agreement.privateKey, 256);
        const responseKey = await aes(secret, decode(String(replyHeader.salt)), replyHeader);
        new Uint8Array(secret).fill(0);
        const data = Uint8Array.from([...decode(String(ciphertext)), ...decode(String(tag))]);
        const decrypted = await crypto.subtle.decrypt({
            name: 'AES-GCM', iv: decode(String(replyHeader.nonce)), additionalData: utf8(canonical(replyHeader)), tagLength: 128
        }, responseKey, data);
        const reply = JSON.parse(new TextDecoder().decode(decrypted)) as {
            nonce: string;
            value: unknown;
        };
        new Uint8Array(decrypted).fill(0);
        if (reply.nonce !== nonce)
            throw Error('网页响应关联无效');
        return { value: reply.value, download: response.headers.get('X-Campus-Download') };
    };
}
