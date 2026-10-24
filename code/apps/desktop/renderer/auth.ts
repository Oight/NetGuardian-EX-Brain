import type { AuthApi, AuthRole, AuthStatus, DesktopApi } from '@campussec/contracts';
import { mountWorkbench } from './app.js';
const roleNames: Record<AuthRole, string> = {
    admin: '管理员', analyst: '分析员', viewer: '只读用户'
};
/** Auth state and credentials are never persisted in browser preferences. Main owns identity. */
export function mountAuthenticatedWorkbench(input: {
    element: HTMLElement;
    api: DesktopApi;
    auth: AuthApi;
}) {
    let mounted: ReturnType<typeof mountWorkbench> | undefined, generation = 0;
    const root = input.element;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
        const node = document.createElement(tag);
        if (text)
            node.textContent = text;
        if (className)
            node.className = className;
        return node;
    };
    function field(form: HTMLFormElement, label: string, name: string, type = 'text') {
        const wrapper = el('label', label, 'field');
        const control = el('input');
        control.name = name;
        control.type = type;
        control.required = true;
        control.autocomplete = type === 'password' ? 'current-password' : 'username';
        wrapper.append(control);
        form.append(wrapper);
        return control;
    }
    function button(text: string, action: () => void, className = 'button secondary') {
        const b = el('button', text, className);
        b.type = 'button';
        b.onclick = action;
        return b;
    }
    async function call<K extends Parameters<AuthApi['invoke']>[0]>(method: K, payload: Parameters<AuthApi['invoke']>[1]) {
        const result = await input.auth.invoke(method, payload as never);
        if (!result.ok)
            throw Error(result.error.message);
        return result.value;
    }
    function panel(title: string) {
        const modal = el('dialog', undefined, 'modal');
        const header = el('header', undefined, 'between');
        header.append(el('h2', title), button('关闭', () => modal.close()));
        modal.append(header);
        root.append(modal);
        modal.addEventListener('close', () => modal.remove());
        modal.showModal();
        return modal;
    }
    function formTask(form: HTMLFormElement, label: string, action: () => Promise<void>) {
        const error = el('p', undefined, 'auth-error'), submit = el('button', label, 'button primary');
        submit.type = 'submit';
        form.append(error, submit);
        form.onsubmit = event => {
            event.preventDefault();
            submit.disabled = true;
            error.textContent = '';
            void action().catch(e => {
                error.textContent = e instanceof Error ? e.message : '操作失败';
            }).finally(() => {
                submit.disabled = false;
            });
        };
    }
    async function accounts() {
        const modal = panel('账号与角色');
        const list = el('div');
        modal.append(el('p', '账号工作空间相互隔离。管理员管理账号与平台设置，分析员执行调查与审核，只读用户查看其获准空间。', 'muted'), list);
        async function load() {
            list.replaceChildren();
            const result = await input.auth.invoke('accounts', {});
            if (!result.ok)
                throw Error(result.error.message);
            for (const account of result.value) {
                const row = el('form', undefined, 'form-grid');
                row.append(el('strong', account.username));
                const role = el('select');
                role.setAttribute('aria-label', account.username + ' 的角色');
                for (const [value, label] of Object.entries(roleNames)) {
                    const option = el('option', label);
                    option.value = value;
                    role.append(option);
                }
                role.value = account.role;
                const enabled = el('input');
                enabled.type = 'checkbox';
                enabled.checked = account.enabled;
                const label = el('label', '启用账号');
                label.append(enabled);
                row.append(role, label);
                formTask(row, '保存角色与状态', async () => {
                    await call('updateAccount', {
                        id: account.id, role: role.value as AuthRole, enabled: enabled.checked
                    });
                    await show();
                });
                list.append(row);
            }
        }
        const form = el('form', undefined, 'form-grid'), username = field(form, '新账号', 'username'), password = field(form, '初始密码（至少 12 位）', 'password', 'password');
        password.autocomplete = 'new-password';
        password.minLength = 12;
        const role = el('select');
        role.name = 'role';
        role.setAttribute('aria-label', '新账号角色');
        for (const [value, label] of Object.entries(roleNames)) {
            const option = el('option', label);
            option.value = value;
            role.append(option);
        }
        role.value = 'analyst';
        form.append(role);
        formTask(form, '创建账号', async () => {
            await call('createAccount', {
                username: username.value, password: password.value, role: role.value as AuthRole
            });
            password.value = '';
            await load();
        });
        modal.append(form);
        await load();
    }
    function password() {
        const modal = panel('修改登录密码'), form = el('form', undefined, 'form-grid'), old = field(form, '当前密码', 'currentPassword', 'password'), next = field(form, '新密码（至少 12 位）', 'newPassword', 'password');
        next.autocomplete = 'new-password';
        next.minLength = 12;
        formTask(form, '修改密码并退出', async () => {
            await call('changePassword', { currentPassword: old.value, newPassword: next.value });
            old.value = '';
            next.value = '';
            await show();
        });
        modal.append(form);
    }
    function openExport() {
        const modal = panel('解密交接文件'), file = el('input');
        file.type = 'file';
        file.accept = '.ngenc,application/json';
        file.setAttribute('aria-label', '选择加密交接文件');
        const form = el('form', undefined, 'form-grid'), result = el('div');
        form.append(el('p', '只允许当前账号解密自己的交接文件；签名或内容校验失败时不会输出明文。'), file);
        formTask(form, '解密并查看', async () => {
            const selected = file.files?.[0];
            if (!selected || selected.size > 6 * 1024 * 1024)
                throw Error('请选择不超过 6 MiB 的加密交接文件');
            const opened = await input.auth.invoke('openExport', { text: await selected.text() });
            if (!opened.ok)
                throw Error(opened.error.message);
            result.replaceChildren(el('h3', opened.value.filename), el('pre', opened.value.text, 'code-block'));
        });
        modal.append(form, result);
    }
    async function show() {
        const ticket = ++generation;
        mounted?.unmount();
        mounted = undefined;
        root.replaceChildren(el('p', '正在核对登录状态…', 'loading'));
        let status: AuthStatus;
        try {
            const result = await input.auth.invoke('status', {});
            if (!result.ok)
                throw Error(result.error.message);
            status = result.value;
        }
        catch (error) {
            root.replaceChildren(el('p', error instanceof Error ? error.message : '无法核实登录状态', 'auth-error'));
            return;
        }
        if (ticket !== generation)
            return;
        root.replaceChildren();
        if (!status.authenticated || !status.account) {
            const page = el('section', undefined, 'auth-page'), card = el('article', undefined, 'auth-card');
            card.append(el('p', 'NETGUARDIAN', 'eyebrow'), el('h1', status.initialized ? '登录安全工作台' : '创建首个管理员'), el('p', status.initialized ? '使用本机账号登录，进入自己的工作空间。' : '首次设置后，管理员可以创建分析员与只读账号。', 'muted'));
            const form = el('form', undefined, 'form-grid'), username = field(form, '账号', 'username'), password = field(form, '密码（至少 12 位）', 'password', 'password');
            username.pattern = '[A-Za-z0-9_.-]{3,64}';
            password.minLength = 12;
            password.maxLength = 256;
            password.autocomplete = status.initialized ? 'current-password' : 'new-password';
            formTask(form, status.initialized ? '登录' : '创建管理员并登录', async () => {
                await call(status.initialized ? 'login' : 'setup', { username: username.value, password: password.value });
                password.value = '';
                await show();
            });
            card.append(form);
            page.append(card);
            root.append(page);
            return;
        }
        const account = status.account, bar = el('aside', undefined, 'account-bar');
        bar.append(el('strong', account.username), el('span', roleNames[account.role] + ' · 独立主体空间', 'muted'), button('解密交接文件', openExport), button('修改密码', password));
        if (account.role === 'admin')
            bar.append(button('账号与角色', () => void accounts().catch(error => {
                const p = el('p', String(error), 'auth-error');
                root.prepend(p);
            })));
        bar.append(button('退出登录', () => void call('logout', {}).catch(() => undefined).then(show)));
        root.append(bar);
        const workspace = el('div');
        root.append(workspace);
        const guarded: DesktopApi = { invoke: async (request) => {
                const reply = await input.api.invoke(request);
                if (!reply.result.ok && reply.result.error.code === 'UNAUTHENTICATED')
                    void show();
                return reply;
            } };
        mounted = mountWorkbench({ element: workspace, api: guarded });
    }
    void show();
    return { unmount() {
            generation++;
            mounted?.unmount();
            root.replaceChildren();
        } };
}
