import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(root, 'dist', 'cli.js');
export const SERVER = join(root, 'examples', 'notes-server.js');

export const live = new Set();
export function killAll() {
  for (const c of live) c.child.kill('SIGKILL');
  live.clear();
}

/** A scripted MCP client talking to `mcp-readonly <args>` over stdio. */
export class Client {
  constructor(args, env = {}, opts = {}) {
    this.child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env }, ...opts });
    this.messages = [];
    this.stderr = '';
    this.waiters = [];
    let buf = '';
    this.child.stdout.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        this.messages.push(m);
        this.waiters = this.waiters.filter((w) => !w(m));
      }
    });
    this.child.stderr.on('data', (c) => (this.stderr += c.toString()));
    live.add(this);
    this.exited = new Promise((r) => this.child.on('close', (code) => {
      live.delete(this);
      r(code);
    }));
  }
  send(m) {
    this.child.stdin.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n');
  }
  /** Wait for the first message (already received or future) satisfying pred. */
  waitFor(pred, ms = 5000) {
    const hit = this.messages.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; stderr:\n${this.stderr}\nmessages:${JSON.stringify(this.messages)}`)), ms);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        resolve(m);
        return true;
      });
    });
  }
  request(id, method, params = {}, ms = 5000) {
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.waitFor((m) => m.id === id && (m.result !== undefined || m.error !== undefined), ms);
  }
  async init() {
    const r = await this.request(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return r;
  }
  async close() {
    this.child.stdin.end();
    return this.exited;
  }
}

export function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
