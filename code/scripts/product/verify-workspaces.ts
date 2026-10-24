import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const root = await read('package.json'), npmLock = await read('package-lock.json');
const bunLock = ts.parseConfigFileTextToJson('bun.lock', await readFile('bun.lock', 'utf8')).config;
let count = 0;
for (const item of await readdir('packages', { withFileTypes: true })) {
    if (!item.isDirectory())
        continue;
    const path = join('packages', item.name).replaceAll('\\', '/');
    let manifest;
    try {
        manifest = await read(path + '/package.json');
    }
    catch (error) {
        if ((error as {
            code?: string;
        }).code === 'ENOENT')
            continue;
        throw error;
    }
    assert.equal(bunLock.workspaces[path]?.name, manifest.name, `${path} missing from bun workspace lock`);
    assert.equal(npmLock.packages[path]?.name, manifest.name, `${path} missing from npm workspace lock`);
    assert.equal(npmLock.packages['node_modules/' + manifest.name]?.link, true, `${manifest.name} missing npm workspace link`);
    for (const [name, entry] of Object.entries(manifest.exports ?? {})) {
        assert.ok(entry && typeof entry === 'object', `${manifest.name}/${name}: exports must declare source and runtime separately`);
        const target = entry as {
            types: string;
            default: string;
        };
        assert.ok(target.types?.endsWith('.ts'));
        assert.ok(target.default?.endsWith('.js'));
        await access(join(path, target.types));
        await access(join(path, target.default));
        await import(manifest.name + (name === '.' ? '' : name.slice(1)));
        count++;
    }
}
assert.deepEqual(npmLock.packages[''].workspaces, root.workspaces);
console.log(`PASS: workspace lock membership, public source/runtime exports and ${count} actual package imports.`);
