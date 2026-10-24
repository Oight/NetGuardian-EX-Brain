/** Additive transport authentication API. Actor/space and signed sessions stay outside Renderer. */
import { z } from 'zod';
import { idSchema } from './schemas.js';
import { fail, ok } from './errors.js';
import type { Result } from './domains/common.js';
export const authRoleSchema = z.enum(['admin', 'analyst', 'viewer']);
export type AuthRole = z.infer<typeof authRoleSchema>;
export const accountViewSchema = z.strictObject({
    id: idSchema, username: z.string().min(3).max(64), role: authRoleSchema, enabled: z.boolean(), spaceId: idSchema
});
export type AccountView = z.infer<typeof accountViewSchema>;
export const authStatusSchema = z.strictObject({
    initialized: z.boolean(), authenticated: z.boolean(), account: accountViewSchema.optional()
});
export type AuthStatus = z.infer<typeof authStatusSchema>;
const credentials = z.strictObject({ username: z.string().regex(/^[A-Za-z0-9_.-]{3,64}$/), password: z.string().min(12).max(256) });
export const exportPayloadSchema = z.strictObject({
    filename: z.string().min(1).max(200), mediaType: z.string().min(1).max(200), text: z.string().max(4 * 1024 * 1024)
});
export const authInputs = {
    status: z.strictObject({}), setup: credentials, login: credentials, logout: z.strictObject({}), accounts: z.strictObject({}), createAccount: credentials.extend({ role: authRoleSchema }), updateAccount: z.strictObject({
        id: idSchema, role: authRoleSchema, enabled: z.boolean()
    }), openExport: z.strictObject({ text: z.string().min(1).max(6 * 1024 * 1024) }), changePassword: z.strictObject({ currentPassword: z.string().min(12).max(256), newPassword: z.string().min(12).max(256) })
};
export type AuthMethod = keyof typeof authInputs;
export type AuthInput<K extends AuthMethod> = z.infer<(typeof authInputs)[K]>;
export type AuthOutput<K extends AuthMethod> = K extends 'openExport' ? z.infer<typeof exportPayloadSchema> : K extends 'accounts' ? AccountView[] : K extends 'createAccount' | 'updateAccount' ? AccountView : AuthStatus;
export interface AuthApi {
    invoke<K extends AuthMethod>(method: K, input: AuthInput<K>): Promise<Result<AuthOutput<K>>>;
}
export function parseAuthRequest(raw: unknown): Result<{
    method: AuthMethod;
    input: unknown;
}> {
    const header = z.strictObject({ method: z.enum(['status', 'setup', 'login', 'logout', 'accounts', 'createAccount', 'updateAccount', 'changePassword', 'openExport']), input: z.unknown() }).safeParse(raw);
    if (!header.success)
        return fail('INVALID_INPUT', '鉴权请求格式无效');
    const parsed = authInputs[header.data.method].safeParse(header.data.input);
    return parsed.success ? ok({ method: header.data.method, input: parsed.data }) : fail('INVALID_INPUT', '账号、密码或角色输入无效');
}
export function parseAuthOutput<K extends AuthMethod>(method: K, value: unknown): Result<AuthOutput<K>> {
    const schema = method === 'openExport' ? exportPayloadSchema : method === 'accounts' ? z.array(accountViewSchema).max(100) : method === 'createAccount' || method === 'updateAccount' ? accountViewSchema : authStatusSchema;
    const parsed = schema.safeParse(value);
    return parsed.success ? ok(parsed.data as AuthOutput<K>) : fail('INTERNAL', '鉴权响应无效');
}
