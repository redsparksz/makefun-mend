// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit performed, as (old path, new path) pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** One line of a hunk or chunk body: context, removed, added, or a `\` marker line. */
type BodyKind = 'ctx' | 'del' | 'add' | 'mark';
interface BodyLine {
  kind: BodyKind;
  text: string;
}

/** A line matched against a file line at a tier (SPEC.md section 5). */
function lineKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where `old` occurs in `file` at `tier`; occurrences may overlap. */
function occurrences(file: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  const keys = old.map((l) => lineKey(l, tier));
  for (let i = 0; i + old.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (lineKey(file[i + j]!, tier) !== keys[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which `old` occurs in `file`, with its positions, or null. */
function findTier(file: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  for (const t of tierList(strict)) {
    const pos = occurrences(file, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to `line` at the first tier where one is, or -1. */
function findSingle(file: string[], line: string, from: number, strict: boolean): number {
  for (const t of tierList(strict)) {
    const key = lineKey(line, t);
    for (let i = from; i < file.length; i += 1) {
      if (lineKey(file[i]!, t) === key) return i;
    }
  }
  return -1;
}

/**
 * The lines a matched block writes: a context line is the file's own matched line, an added line is
 * re-indented at tier 2 from the old block's first line to the file's first matched line.
 */
function spliceBody(file: string[], at: number, body: BodyLine[], tier: number, oldFirst: string): string[] {
  const f = leadingWs(file[at] ?? '');
  const p = leadingWs(oldFirst);
  const out: string[] = [];
  let o = 0;
  for (const b of body) {
    if (b.kind === 'ctx') { out.push(file[at + o]!); o += 1; }
    else if (b.kind === 'del') { o += 1; }
    else if (b.kind === 'add') {
      const t = b.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
  }
  return out;
}

/** The old lines of a body (context and removed lines) and how many lines its new side holds. */
function bodyOldNew(body: BodyLine[]): { oldLines: string[]; newCount: number } {
  const oldLines: string[] = [];
  let newCount = 0;
  for (const b of body) {
    if (b.kind === 'ctx') { oldLines.push(b.text); newCount += 1; }
    else if (b.kind === 'del') oldLines.push(b.text);
    else if (b.kind === 'add') newCount += 1;
  }
  return { oldLines, newCount };
}

/** Whether a `\` line follows the body's last context or added line. */
function bodyNoEol(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => { if (b.kind === 'ctx' || b.kind === 'add') last = i; });
  return last >= 0 && body[last + 1]?.kind === 'mark';
}

/** A body with its trailing empty context lines removed; they are not part of it. */
function trimBody(body: BodyLine[]): BodyLine[] {
  const out = [...body];
  while (out.length > 0) {
    const lastB = out[out.length - 1]!;
    if (lastB.kind === 'ctx' && lastB.text === '') out.pop();
    else break;
  }
  return out;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  pair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A `--- ` or `+++ ` header path: up to the first tab, surrounding spaces removed, `/dev/null` is no file. */
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!.trim();
  if (rest === '/dev/null') return null;
  return stripAB(rest);
}

function applyHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { oldLines } = bodyOldNew(h.body);
  const lines = state.lines;
  if (oldLines.length === 0) {
    const at = Math.min(h.a + d, lines.length);
    const ins: string[] = [];
    for (const b of h.body) if (b.kind === 'add') ins.push(b.text);
    const next = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
    const final = at === lines.length ? !bodyNoEol(h.body) : state.final;
    return { lines: next, br: state.br, final };
  }
  const found = findTier(lines, oldLines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(at - target)) at = p;
  }
  const rep = spliceBody(lines, at, h.body, found.tier, oldLines[0]!);
  const next = [...lines.slice(0, at), ...rep, ...lines.slice(at + oldLines.length)];
  const touchesEnd = at + oldLines.length === lines.length;
  const final = touchesEnd ? !bodyNoEol(h.body) : state.final;
  return { lines: next, br: state.br, final };
}

function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur = state;
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newCount } = bodyOldNew(h.body);
    cur = applyHunk(cur, h, d, strict, path);
    d += newCount - oldLines.length;
  }
  return cur;
}

/** Whether a `\` line follows the last `+` line of all the hunks. */
function creationNoEol(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi -= 1) {
    const h = hunks[hi]!;
    for (let k = h.body.length - 1; k >= 0; k -= 1) {
      if (h.body[k]!.kind === 'add') return h.body[k + 1]?.kind === 'mark';
    }
  }
  return false;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  const devNull = (p: string | null): string | null => (p === '/dev/null' ? null : p);
  // The `---`/`+++` pair names the paths when there is one, else the rename lines, else the `diff --git` line.
  const oldP = sec.pair ? devNull(sec.oldPath) : devNull(sec.renameOld ?? sec.gitOld);
  const newP = sec.pair ? devNull(sec.newPath) : devNull(sec.renameNew ?? sec.gitNew);
  const isCreate = oldP === null || sec.create;
  const isDelete = newP === null || sec.remove;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'add') plus.push(b.text);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (creationNoEol(sec.hunks) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(applyHunks(splitFile(text), sec.hunks, strict, oldP)));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? '';
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(text), sec.hunks, strict, p)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let pairDone = false;
  let hunk: Hunk | null = null;
  const newSection = (): Section => ({ oldPath: null, newPath: null, pair: false, renameOld: null, renameNew: null, gitOld: null, gitNew: null, create: false, remove: false, hunks: [] });
  const endHunk = (): void => {
    if (hunk !== null && cur !== null) {
      hunk.body = trimBody(hunk.body);
      cur.hunks.push(hunk);
      hunk = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      // Collecting a hunk body.
      if (line.startsWith('diff --git ')) { endHunk(); continue; }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) { endHunk(); continue; }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (line.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) hunk.body.push({ kind: 'del', text: line.slice(1) });
        else if (line.startsWith('+')) hunk.body.push({ kind: 'add', text: line.slice(1) });
        else hunk.body.push({ kind: 'mark', text: line });
        i += 1;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      pairDone = false;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !pairDone) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.pair = true;
        pairDone = true;
      } else {
        cur = newSection();
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.pair = true;
        sections.push(cur);
        inHeader = true;
        pairDone = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      inHeader = false;
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.newPath = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  endHunk();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = splitFile(text);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const body: BodyLine[] = newLines.map((t) => ({ kind: 'add' as const, text: t }));
    const rep = spliceBody(st.lines, at, body, found.tier, oldLines[0]!);
    st.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(st));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { sep = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') { end = j; break; }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
  fromAt: boolean;
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function applyV4AChunk(state: FileState, chunk: VChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const at = findSingle(state.lines, chunk.anchor, cur, strict);
    if (at < 0) throw new Fail('no-match', path);
    cur = at + 1;
  }
  const { oldLines } = bodyOldNew(chunk.body);
  if (oldLines.length === 0) {
    const at = chunk.eof ? state.lines.length : cur;
    const ins: string[] = [];
    for (const b of chunk.body) if (b.kind === 'add') ins.push(b.text);
    const lines = [...state.lines.slice(0, at), ...ins, ...state.lines.slice(at)];
    return { state: { lines, br: state.br, final: state.final }, cursor: at + ins.length };
  }
  // The first occurrence at or after the cursor, at the first tier with one; an end-of-file chunk
  // takes only an occurrence that ends at the file's last line.
  let chosen: { tier: number; at: number } | null = null;
  for (const t of tierList(strict)) {
    const pos = occurrences(state.lines, oldLines, t).filter((p) => p >= cur && (!chunk.eof || p + oldLines.length === state.lines.length));
    if (pos.length > 0) { chosen = { tier: t, at: pos[0]! }; break; }
  }
  if (chosen === null) throw new Fail('no-match', path);
  const rep = spliceBody(state.lines, chosen.at, chunk.body, chosen.tier, oldLines[0]!);
  const lines = [...state.lines.slice(0, chosen.at), ...rep, ...state.lines.slice(chosen.at + oldLines.length)];
  return { state: { lines, br: state.br, final: state.final }, cursor: chosen.at + rep.length };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = splitFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4AChunk(state, chunk, cursor, strict, path);
      state = r.state;
      cursor = r.cursor;
    }
    const out = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const addLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l === '') { addLines.push(''); i += 1; continue; }
        if (l.startsWith('+')) { addLines.push(l.slice(1)); i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      edits.push(v4aAddEdit(path, addLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: l.slice(2).trim(), eof: false, body: [], fromAt: true };
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l === '' && cur === null && !firstChunk) { i += 1; continue; }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [], fromAt: false };
          }
          const kind: BodyKind = l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'del' : 'add';
          cur.body.push({ kind, text: kind === 'ctx' ? (l === '' ? '' : l.slice(1)) : l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) {
        const lastC = chunks[chunks.length - 1]!;
        lastC.body = trimBody(lastC.body);
        if (lastC.body.length === 0 && !lastC.fromAt && !lastC.eof && lastC.anchor === null) chunks.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The changed rows: a move whose old path existed before the patch and whose new path did not
  // is one `R` line sorted by its new path, replacing that pair's `D` and `A` lines.
  const rows: Array<{ key: string; line: string }> = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (paired.has(oldP) || paired.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.get(oldP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null && nowNew !== undefined) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
