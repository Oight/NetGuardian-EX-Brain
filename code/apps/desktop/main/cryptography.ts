import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@campussec/contracts';
const b64 = (v: Uint8Array) => Buffer.from(v).toString('base64url');
const bytes = (v: string) => {
    const out = Buffer.from(v, 'base64url');
    if (b64(out) !== v)
        throw Error('Noncanonical binary');
    return out;
};
const binary = z.string().regex(/^[A-Za-z0-9_-]+$/).max(96 * 1024 * 1024);
const envelope = z.strictObject({
    version: z.literal(1), suite: z.literal('Ed25519+X25519+HKDF-SHA256+AES-256-GCM'), context: z.string().min(1).max(256), recipient: binary.max(100), sender: binary.max(100), ephemeral: binary.max(256), salt: binary.max(64), nonce: binary.max(32), ciphertext: binary, tag: binary.max(32), signature: binary.max(128)
});
export interface IdentityKeys {
    signing: KeyObject;
    agreement: KeyObject;
}
export interface PublicIdentity {
    signing: string;
    agreement: string;
}
export function generateIdentityKeys(): IdentityKeys {
    return { signing: generateKeyPairSync('ed25519').privateKey, agreement: generateKeyPairSync('x25519').privateKey };
}
export function publicIdentity(keys: IdentityKeys): PublicIdentity {
    return { signing: b64(createPublicKey(keys.signing).export({ format: 'der', type: 'spki' })), agreement: b64(createPublicKey(keys.agreement).export({ format: 'der', type: 'spki' })) };
}
export function exportPrivate(keys: IdentityKeys) {
    return { signing: b64(keys.signing.export({ format: 'der', type: 'pkcs8' })), agreement: b64(keys.agreement.export({ format: 'der', type: 'pkcs8' })) };
}
export function importPrivate(raw: {
    signing: string;
    agreement: string;
}): IdentityKeys {
    const keys = { signing: createPrivateKey({
            key: bytes(raw.signing), format: 'der', type: 'pkcs8'
        }), agreement: createPrivateKey({
            key: bytes(raw.agreement), format: 'der', type: 'pkcs8'
        }) };
    if (keys.signing.asymmetricKeyType !== 'ed25519' || keys.agreement.asymmetricKeyType !== 'x25519')
        throw Error('Wrong private key algorithm');
    return keys;
}
const publicKey = (raw: string, kind: 'ed25519' | 'x25519') => {
    const key = createPublicKey({
        key: bytes(raw), format: 'der', type: 'spki'
    });
    if (key.asymmetricKeyType !== kind)
        throw Error('Wrong public key algorithm');
    return key;
};
export const keyId = (publicDer: string) => b64(createHash('sha256').update(bytes(publicDer)).digest());
/** Ed25519 signs; X25519 agrees a fresh ephemeral secret; AES-GCM encrypts.
 * This is a versioned application envelope, not a claim to implement HPKE/JWE or replace TLS.
 * Recipient and sender public keys must come from a trusted account/transport, never the envelope.
 */
export function seal(plaintext: Uint8Array, context: string, sender: IdentityKeys, recipient: PublicIdentity): string {
    if (plaintext.length === 0 || plaintext.length > (context.startsWith("database:") ? 64 : 4) * 1024 * 1024 || !context || context.length > 256)
        throw Error('Invalid envelope input');
    const temporary = generateKeyPairSync('x25519');
    const pub = publicIdentity(sender);
    const header = {
        version: 1 as const, suite: 'Ed25519+X25519+HKDF-SHA256+AES-256-GCM' as const, context, recipient: keyId(recipient.agreement), sender: keyId(pub.signing), ephemeral: b64(temporary.publicKey.export({ format: 'der', type: 'spki' })), salt: b64(randomBytes(32)), nonce: b64(randomBytes(12))
    };
    const shared = diffieHellman({ privateKey: temporary.privateKey, publicKey: publicKey(recipient.agreement, 'x25519') });
    if (shared.every(v => v === 0))
        throw Error('Invalid agreement');
    const key = Buffer.from(hkdfSync('sha256', shared, bytes(header.salt), Buffer.from(canonicalJson(header)), 32));
    shared.fill(0);
    try {
        const cipher = createCipheriv('aes-256-gcm', key, bytes(header.nonce));
        cipher.setAAD(Buffer.from(canonicalJson(header)));
        const unsigned = {
            ...header, ciphertext: b64(Buffer.concat([cipher.update(plaintext), cipher.final()])), tag: b64(cipher.getAuthTag())
        };
        return canonicalJson({ ...unsigned, signature: b64(sign(null, Buffer.from(canonicalJson(unsigned)), sender.signing)) });
    }
    finally {
        key.fill(0);
    }
}
export function openSealed(text: string, context: string, recipient: IdentityKeys, trustedSender: PublicIdentity): Buffer {
    if (text.length > (context.startsWith("database:") ? 96 : 6) * 1024 * 1024)
        throw Error('Envelope too large');
    const parsed = envelope.parse(JSON.parse(text));
    const { signature, ciphertext, tag, ...header } = parsed;
    const own = publicIdentity(recipient);
    if (header.context !== context || header.recipient !== keyId(own.agreement) || header.sender !== keyId(trustedSender.signing) || bytes(header.salt).length !== 32 || bytes(header.nonce).length !== 12 || bytes(tag).length !== 16 || bytes(signature).length !== 64)
        throw Error('Envelope context mismatch');
    if (!verify(null, Buffer.from(canonicalJson({
        ...header, ciphertext, tag
    })), publicKey(trustedSender.signing, 'ed25519'), bytes(signature)))
        throw Error('Envelope signature mismatch');
    const shared = diffieHellman({ privateKey: recipient.agreement, publicKey: publicKey(header.ephemeral, 'x25519') });
    if (shared.every(v => v === 0))
        throw Error('Invalid agreement');
    const key = Buffer.from(hkdfSync('sha256', shared, bytes(header.salt), Buffer.from(canonicalJson(header)), 32));
    shared.fill(0);
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes(header.nonce));
        decipher.setAAD(Buffer.from(canonicalJson(header)));
        decipher.setAuthTag(bytes(tag));
        return Buffer.concat([decipher.update(bytes(ciphertext)), decipher.final()]);
    }
    finally {
        key.fill(0);
    }
}
export function signClaims(claims: Record<string, unknown>, keys: IdentityKeys): string {
    const payload = b64(Buffer.from(canonicalJson(claims)));
    return payload + '.' + b64(sign(null, Buffer.from('netguardian-session-v1.' + payload), keys.signing));
}
export function verifyClaims(token: string, signing: string): unknown {
    if (token.length > 8192)
        throw Error('Token too large');
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !verify(null, Buffer.from('netguardian-session-v1.' + parts[0]), publicKey(signing, 'ed25519'), bytes(parts[1])))
        throw Error('Invalid token signature');
    return JSON.parse(bytes(parts[0]).toString('utf8'));
}
