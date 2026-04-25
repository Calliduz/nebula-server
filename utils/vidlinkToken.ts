import fs from 'fs';
import path from 'path';
import sodium from 'libsodium-wrappers';

// globalThis.crypto is already available in Node 24.10.0

// Polyfill global environment for Go WebAssembly
if (!globalThis.fs) {
    (globalThis as any).fs = {
        constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
        writeSync(fd: number, buf: Uint8Array) {
            return buf.length;
        },
        write(fd: number, buf: Uint8Array, offset: number, length: number, position: number, callback: (err: Error | null, n: number) => void) {
            callback(null, buf.length);
        },
        chmod(path: string, mode: number, callback: any) { callback(new Error("not implemented")); },
        chown(path: string, uid: number, gid: number, callback: any) { callback(new Error("not implemented")); },
        close(fd: number, callback: any) { callback(new Error("not implemented")); },
        fchmod(fd: number, mode: number, callback: any) { callback(new Error("not implemented")); },
        fchown(fd: number, uid: number, gid: number, callback: any) { callback(new Error("not implemented")); },
        fstat(fd: number, callback: any) { callback(new Error("not implemented")); },
        fsync(fd: number, callback: any) { callback(null); },
        ftruncate(fd: number, length: number, callback: any) { callback(new Error("not implemented")); },
        lchown(path: string, uid: number, gid: number, callback: any) { callback(new Error("not implemented")); },
        link(path: string, link: string, callback: any) { callback(new Error("not implemented")); },
        lstat(path: string, callback: any) { callback(new Error("not implemented")); },
        mkdir(path: string, perm: number, callback: any) { callback(new Error("not implemented")); },
        open(path: string, flags: number, mode: number, callback: any) { callback(new Error("not implemented")); },
        read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number, callback: any) { callback(new Error("not implemented")); },
        readdir(path: string, callback: any) { callback(new Error("not implemented")); },
        readlink(path: string, callback: any) { callback(new Error("not implemented")); },
        rename(from: string, to: string, callback: any) { callback(new Error("not implemented")); },
        rmdir(path: string, callback: any) { callback(new Error("not implemented")); },
        stat(path: string, callback: any) { callback(new Error("not implemented")); },
        symlink(path: string, link: string, callback: any) { callback(new Error("not implemented")); },
        truncate(path: string, length: number, callback: any) { callback(new Error("not implemented")); },
        unlink(path: string, callback: any) { callback(new Error("not implemented")); },
        utimes(path: string, atime: number, mtime: number, callback: any) { callback(new Error("not implemented")); },
    };
}

if (!globalThis.process) {
    (globalThis as any).process = {
        getuid() { return -1; },
        getgid() { return -1; },
        geteuid() { return -1; },
        getegid() { return -1; },
        getgroups() { throw new Error("not implemented"); },
        pid: -1,
        ppid: -1,
        umask() { throw new Error("not implemented"); },
        cwd() { throw new Error("not implemented"); },
        chdir() { throw new Error("not implemented"); },
    };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Go WebAssembly Bridge (Extracted from VidLink.pro)
 * Renamed from Dm to Go for clarity, as it follows the standard syscall/js bridge pattern.
 */
class GoBridge {
    argv: string[];
    env: Record<string, string>;
    importObject: WebAssembly.Imports;
    mem!: DataView;
    _inst!: WebAssembly.Instance;
    _values: any[] = [];
    _goRefCounts: number[] = [];
    _ids = new Map<any, number>();
    _idPool: number[] = [];
    exited = false;
    _exitPromise: Promise<void>;
    _resolveExitPromise!: () => void;
    _pendingEvent: any = null;
    _scheduledTimeouts = new Map<number, NodeJS.Timeout>();
    _nextCallbackTimeoutID = 1;

    constructor() {
        this.argv = ["js"];
        this.env = {};
        this._exitPromise = new Promise((resolve) => {
            this._resolveExitPromise = resolve;
        });

        const setInt64 = (addr: number, v: number) => {
            this.mem.setUint32(addr + 0, v, true);
            this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
        };

        const getInt64 = (addr: number) => {
            const low = this.mem.getUint32(addr + 0, true);
            const high = this.mem.getInt32(addr + 4, true);
            return low + high * 4294967296;
        };

        const loadValue = (addr: number) => {
            const f = this.mem.getFloat64(addr, true);
            if (f === 0) return undefined;
            if (!isNaN(f)) return f;
            const id = this.mem.getUint32(addr, true);
            return this._values[id];
        };

        const storeValue = (addr: number, v: any) => {
            const nanHead = 0x7ff80000;
            if (typeof v === "number" && v !== 0) {
                if (isNaN(v)) {
                    this.mem.setUint32(addr + 4, nanHead, true);
                    this.mem.setUint32(addr, 0, true);
                    return;
                }
                this.mem.setFloat64(addr, v, true);
                return;
            }
            if (v === undefined) {
                this.mem.setFloat64(addr, 0, true);
                return;
            }
            let id = this._ids.get(v);
            if (id === undefined) {
                id = this._idPool.pop();
                if (id === undefined) id = this._values.length;
                this._values[id] = v;
                this._goRefCounts[id] = 0;
                this._ids.set(v, id);
            }
            this._goRefCounts[id]++;
            let typeFlag = 0;
            switch (typeof v) {
                case "object": if (v !== null) typeFlag = 1; break;
                case "string": typeFlag = 2; break;
                case "symbol": typeFlag = 3; break;
                case "function": typeFlag = 4; break;
            }
            this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
            this.mem.setUint32(addr, id, true);
        };

        const loadSlice = (addr: number) => {
            const array = getInt64(addr + 0);
            const len = getInt64(addr + 8);
            return new Uint8Array((this._inst.exports.mem as WebAssembly.Memory).buffer, array, len);
        };

        const loadSliceOfValues = (addr: number) => {
            const array = getInt64(addr + 0);
            const len = getInt64(addr + 8);
            const a = new Array(len);
            for (let i = 0; i < len; i++) {
                a[i] = loadValue(array + i * 8);
            }
            return a;
        };

        const loadString = (addr: number) => {
            const saddr = getInt64(addr + 0);
            const len = getInt64(addr + 8);
            return decoder.decode(new DataView((this._inst.exports.mem as WebAssembly.Memory).buffer, saddr, len));
        };

        const timeOrigin = Date.now() - performance.now();

        this.importObject = {
            _gotest: { add: (a: number, b: number) => a + b },
            gojs: {
                "runtime.wasmExit": (sp: number) => {
                    sp >>>= 0;
                    const code = this.mem.getInt32(sp + 8, true);
                    this.exited = true;
                    this._resolveExitPromise();
                },
                "runtime.wasmWrite": (sp: number) => {
                    sp >>>= 0;
                    const fd = getInt64(sp + 8);
                    const p = getInt64(sp + 16);
                    const n = this.mem.getInt32(sp + 24, true);
                    const buf = new Uint8Array((this._inst.exports.mem as WebAssembly.Memory).buffer, p, n);
                    if (fd === 1 || fd === 2) {
                        process.stdout.write(decoder.decode(buf));
                    }
                },
                "runtime.resetMemoryDataView": (sp: number) => {
                    sp >>>= 0;
                    this.mem = new DataView((this._inst.exports.mem as WebAssembly.Memory).buffer);
                },
                "runtime.nanotime1": (sp: number) => {
                    sp >>>= 0;
                    setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);
                },
                "runtime.walltime": (sp: number) => {
                    sp >>>= 0;
                    const msec = new Date().getTime();
                    setInt64(sp + 8, msec / 1000);
                    this.mem.setInt32(sp + 16, (msec % 1000) * 1000000, true);
                },
                "runtime.scheduleTimeoutEvent": (sp: number) => {
                    sp >>>= 0;
                    const id = this._nextCallbackTimeoutID++;
                    this._scheduledTimeouts.set(id, setTimeout(() => {
                        this._resume();
                        const timeout = this._scheduledTimeouts.get(id);
                        if (timeout) {
                            this._resume();
                        }
                    }, getInt64(sp + 8)));
                    this.mem.setInt32(sp + 16, id, true);
                },
                "runtime.clearTimeoutEvent": (sp: number) => {
                    sp >>>= 0;
                    const id = this.mem.getInt32(sp + 8, true);
                    const timeout = this._scheduledTimeouts.get(id);
                    if (timeout) clearTimeout(timeout);
                    this._scheduledTimeouts.delete(id);
                },
                "runtime.getRandomData": (sp: number) => {
                    sp >>>= 0;
                    crypto.getRandomValues(loadSlice(sp + 8));
                },
                "syscall/js.finalizeRef": (sp: number) => {
                    sp >>>= 0;
                    const id = this.mem.getUint32(sp + 8, true);
                    this._goRefCounts[id]--;
                    if (this._goRefCounts[id] === 0) {
                        const v = this._values[id];
                        this._values[id] = null;
                        this._ids.delete(v);
                        this._idPool.push(id);
                    }
                },
                "syscall/js.stringVal": (sp: number) => {
                    sp >>>= 0;
                    storeValue(sp + 24, loadString(sp + 8));
                },
                "syscall/js.valueGet": (sp: number) => {
                    sp >>>= 0;
                    const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
                    sp = (this._inst.exports.getsp as Function)() >>> 0;
                    storeValue(sp + 32, result);
                },
                "syscall/js.valueSet": (sp: number) => {
                    sp >>>= 0;
                    Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
                },
                "syscall/js.valueDelete": (sp: number) => {
                    sp >>>= 0;
                    Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
                },
                "syscall/js.valueIndex": (sp: number) => {
                    sp >>>= 0;
                    storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
                },
                "syscall/js.valueSetIndex": (sp: number) => {
                    sp >>>= 0;
                    Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
                },
                "syscall/js.valueCall": (sp: number) => {
                    sp >>>= 0;
                    try {
                        const v = loadValue(sp + 8);
                        const m = Reflect.get(v, loadString(sp + 16));
                        const args = loadSliceOfValues(sp + 32);
                        const result = Reflect.apply(m, v, args);
                        sp = (this._inst.exports.getsp as Function)() >>> 0;
                        storeValue(sp + 56, result);
                        this.mem.setUint8(sp + 64, 1);
                    } catch (err) {
                        sp = (this._inst.exports.getsp as Function)() >>> 0;
                        storeValue(sp + 56, err);
                        this.mem.setUint8(sp + 64, 0);
                    }
                },
                "syscall/js.valueInvoke": (sp: number) => {
                    sp >>>= 0;
                    try {
                        const v = loadValue(sp + 8);
                        const args = loadSliceOfValues(sp + 16);
                        const result = Reflect.apply(v, undefined, args);
                        sp = (this._inst.exports.getsp as Function)() >>> 0;
                        storeValue(sp + 40, result);
                        this.mem.setUint8(sp + 48, 1);
                    } catch (err) {
                        sp = (this._inst.exports.getsp as Function)() >>> 0;
                        storeValue(sp + 40, err);
                        this.mem.setUint8(sp + 48, 0);
                    }
                },
                "syscall/js.valueNew": (sp: number) => {
                    sp >>>= 0;
                    try {
                        const v = loadValue(sp + 8);
                        const args = loadSliceOfValues(sp + 16);
                        const result = Reflect.construct(v, args);
                        sp = (this._inst.exports.getsp as Function)() >>> 0;
                        storeValue(sp + 40, result);
                        this.mem.setUint8(sp + 48, 1);
                    } catch (err) {
                        sp = (this._inst.exports.getsp as Function)() >>> 0;
                        storeValue(sp + 40, err);
                        this.mem.setUint8(sp + 48, 0);
                    }
                },
                "syscall/js.valueLength": (sp: number) => {
                    sp >>>= 0;
                    setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
                },
                "syscall/js.valuePrepareString": (sp: number) => {
                    sp >>>= 0;
                    const str = encoder.encode(String(loadValue(sp + 8)));
                    storeValue(sp + 16, str);
                    setInt64(sp + 24, str.length);
                },
                "syscall/js.valueLoadString": (sp: number) => {
                    sp >>>= 0;
                    const str = loadValue(sp + 8);
                    loadSlice(sp + 16).set(str);
                },
                "syscall/js.valueInstanceOf": (sp: number) => {
                    sp >>>= 0;
                    this.mem.setUint8(sp + 24, loadValue(sp + 8) instanceof loadValue(sp + 16) ? 1 : 0);
                },
                "syscall/js.copyBytesToGo": (sp: number) => {
                    sp >>>= 0;
                    const dst = loadSlice(sp + 8);
                    const src = loadValue(sp + 32);
                    if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
                        this.mem.setUint8(sp + 48, 0);
                        return;
                    }
                    const toCopy = src.subarray(0, dst.length);
                    dst.set(toCopy);
                    setInt64(sp + 40, toCopy.length);
                    this.mem.setUint8(sp + 48, 1);
                },
                "syscall/js.copyBytesToJS": (sp: number) => {
                    sp >>>= 0;
                    const dst = loadValue(sp + 8);
                    const src = loadSlice(sp + 16);
                    if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
                        this.mem.setUint8(sp + 48, 0);
                        return;
                    }
                    const toCopy = src.subarray(0, dst.length);
                    dst.set(toCopy);
                    setInt64(sp + 40, toCopy.length);
                    this.mem.setUint8(sp + 48, 1);
                },
                debug: (value: any) => console.log(value),
            },
        };
    }

    async run(instance: WebAssembly.Instance) {
        this._inst = instance;
        this.mem = new DataView((this._inst.exports.mem as WebAssembly.Memory).buffer);
        this._values = [NaN, 0, null, true, false, globalThis, this];
        this._goRefCounts = new Array(this._values.length).fill(Infinity);
        this._ids = new Map<any, number>([[0, 1], [null, 2], [true, 3], [false, 4], [globalThis, 5], [this, 6]]);
        this._idPool = [];
        this.exited = false;
        let offset = 4096;
        const strPtr = (str: string) => {
            const ptr = offset;
            const bytes = encoder.encode(str + "\0");
            new Uint8Array((this._inst.exports.mem as WebAssembly.Memory).buffer, offset, bytes.length).set(bytes);
            offset += bytes.length;
            if (offset % 8 !== 0) offset += 8 - (offset % 8);
            return ptr;
        };
        const argc = this.argv.length;
        const argvPtrs: number[] = [];
        this.argv.forEach((arg) => argvPtrs.push(strPtr(arg)));
        argvPtrs.push(0);
        const keys = Object.keys(this.env).sort();
        keys.forEach((key) => argvPtrs.push(strPtr(`${key}=${this.env[key]}`)));
        argvPtrs.push(0);
        const argv = offset;
        argvPtrs.forEach((ptr) => {
            this.mem.setUint32(offset, ptr, true);
            this.mem.setUint32(offset + 4, 0, true);
            offset += 8;
        });
        (this._inst.exports.run as Function)(argc, argv);
        if (this.exited) this._resolveExitPromise();
        await this._exitPromise;
    }

    _resume() {
        if (this.exited) throw new Error("program has already exited");
        (this._inst.exports.resume as Function)();
        if (this.exited) this._resolveExitPromise();
    }

    _makeFuncWrapper(id: number) {
        const go = this;
        return function (this: any) {
            const event: any = { id: id, this: this, args: arguments };
            go._pendingEvent = event;
            go._resume();
            return event.result;
        };
    }
}

let isInitialized = false;

/**
 * Initializes the WASM environment and exposes the getAdv function.
 */
export async function initVidLink() {
    if (isInitialized) return;

    try {
        await sodium.ready;
        (globalThis as any).sodium = sodium;

        const go = new GoBridge();
        const wasmPath = path.join(process.cwd(), 'scratch', 'fu.wasm');
        const wasmBuffer = fs.readFileSync(wasmPath);
        
        const { instance } = await WebAssembly.instantiate(wasmBuffer, go.importObject);
        
        // This will define window.getAdv (or globalThis.getAdv)
        go.run(instance).catch(err => {
            if (!go.exited) console.error('VidLink WASM execution error:', err);
        });

        // Wait a bit for Go to initialize globals
        await new Promise(resolve => setTimeout(resolve, 500));
        isInitialized = true;
    } catch (error) {
        console.error('Failed to initialize VidLink WASM:', error);
        throw error;
    }
}

/**
 * Generates a VidLink API token for the given movie/show ID.
 * @param id TMDB ID of the movie or show.
 */
export async function getVidLinkToken(id: string): Promise<string> {
    await initVidLink();
    
    const getAdv = (globalThis as any).getAdv;
    if (typeof getAdv !== 'function') {
        throw new Error('VidLink getAdv function not found after initialization');
    }

    // According to the VidLink source code, it passes the ID as a string
    const token = getAdv(id);
    return token;
}
